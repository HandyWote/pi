/**
 * Tool-call handler: wires the gate to the askers and the rule store.
 *
 * Flow: extract tool info → gate.decide → allow/deny/ask.
 * Ask decisions go through an asker chosen by UI availability:
 * - interactive: modal select dialog; the user's choice is applied
 *   (allowOnce / allowSession / alwaysAllow / alwaysDeny / deny)
 * - headless (print/json/rpc): deterministic auto-deny with guidance.
 *
 * Denials are recorded to the audit log and the block reason (returned to
 * the model as the tool error) carries fix guidance.
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@handy_wote/pi-coding-agent";
import type { Asker } from "./asker.ts";
import { HeadlessAsker } from "./askers/headless.ts";
import { TuiAsker } from "./askers/tui.ts";
import type { DenialAudit } from "./audit.ts";
import type { Decision, Gate } from "./gate.ts";
import type { PermissionRuleStore } from "./rules/index.ts";
import type { SessionState } from "./state.ts";
import { extractToolCallInfo, type ToolCallInfo } from "./tool-input.ts";

const DESCRIPTION_LIMIT = 500;
const RULE_SUGGESTION_LIMIT = 200;

/** Auto-mode denial limits (aligned with Claude Code's DENIAL_LIMITS). */
export const DENIAL_LIMITS = {
	maxConsecutive: 3,
	maxTotal: 20,
} as const;

export function shouldFallbackToPrompt(tracking: { consecutiveDenials: number; totalDenials: number }): boolean {
	return (
		tracking.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive || tracking.totalDenials >= DENIAL_LIMITS.maxTotal
	);
}

export interface GateHandlerDeps {
	store: PermissionRuleStore;
	state: SessionState;
	audit: DenialAudit;
	gate: Gate;
	tuiAsker?: Asker;
	headlessAsker?: Asker;
}

export class GateHandler {
	private readonly store: PermissionRuleStore;
	private readonly state: SessionState;
	private readonly audit: DenialAudit;
	private readonly gate: Gate;
	private readonly tuiAsker: Asker;
	private readonly headlessAsker: Asker;

	constructor(deps: GateHandlerDeps) {
		this.store = deps.store;
		this.state = deps.state;
		this.audit = deps.audit;
		this.gate = deps.gate;
		this.tuiAsker = deps.tuiAsker ?? new TuiAsker();
		this.headlessAsker = deps.headlessAsker ?? new HeadlessAsker();
	}

	async process(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const info = extractToolCallInfo(event);
		const mode = this.state.getMode();
		const decision = await this.gate.decide(
			{
				info,
				rules: this.store.collection(),
				mode,
				cwd: ctx.cwd,
			},
			ctx,
		);

		// Auto-mode denial tracking: classifier denials count toward the
		// fallback limits; any allowed call resets the consecutive counter.
		if (mode === "auto") {
			if (decision.behavior === "allow") {
				this.state.recordSuccess();
			} else if (decision.behavior === "deny") {
				this.state.recordDenial();
				// Over the limit in interactive mode: fall back to asking the
				// user instead of auto-denying (they may review and approve).
				if (
					ctx.hasUI &&
					decision.reason.type === "classifier" &&
					shouldFallbackToPrompt(this.state.getDenialTracking())
				) {
					return this.askWithFallback(info, decision, mode, ctx);
				}
			}
		}

		switch (decision.behavior) {
			case "allow":
				return undefined;
			case "deny": {
				await this.recordDenial(info, decision, mode, ctx);
				return { block: true, reason: decision.message };
			}
			case "ask": {
				const asker = ctx.hasUI ? this.tuiAsker : this.headlessAsker;
				const outcome = await asker.ask(decision.ask, ctx);
				switch (outcome.choice) {
					case "allowOnce":
						return undefined;
					case "allowSession": {
						this.store.addSessionAllow(suggestedRule(info));
						return undefined;
					}
					case "alwaysAllow": {
						await this.store.addUserRule("allow", suggestedRule(info));
						return undefined;
					}
					case "alwaysDeny": {
						await this.store.addUserRule("deny", suggestedRule(info));
						await this.recordDenial(info, decision, mode, ctx);
						return {
							block: true,
							reason: `Permission denied: ${decision.ask.reason} (always deny rule added)`,
						};
					}
					case "deny":
					case "cancel": {
						await this.recordDenial(info, decision, mode, ctx);
						return { block: true, reason: buildDenyMessage(info, decision) };
					}
					default:
						// Unknown choice: fail closed.
						await this.recordDenial(info, decision, mode, ctx);
						return { block: true, reason: buildDenyMessage(info, decision) };
				}
			}
			default:
				// Unknown decision behavior: fail closed.
				return { block: true, reason: `Permission check failed for ${info.toolName}` };
		}
	}

	private async askWithFallback(
		info: ToolCallInfo,
		decision: Extract<Decision, { behavior: "deny" }>,
		mode: string,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> {
		const tracking = this.state.getDenialTracking();
		const warning = `Auto mode blocked ${tracking.totalDenials} actions; review before continuing.`;
		const outcome = await this.tuiAsker.ask(
			{
				toolName: info.toolName,
				description: info.description,
				reason: `${decision.message} (${warning})`,
			},
			ctx,
		);
		switch (outcome.choice) {
			case "allowOnce":
				return undefined;
			case "allowSession":
				this.store.addSessionAllow(suggestedRule(info));
				return undefined;
			case "alwaysAllow":
				await this.store.addUserRule("allow", suggestedRule(info));
				return undefined;
			case "alwaysDeny":
				await this.store.addUserRule("deny", suggestedRule(info));
				await this.recordDenial(info, decision, mode, ctx);
				return { block: true, reason: decision.message };
			default:
				await this.recordDenial(info, decision, mode, ctx);
				return { block: true, reason: decision.message };
		}
	}

	private async recordDenial(
		info: ToolCallInfo,
		decision: Decision,
		mode: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const reason = decision.reason;
		await this.audit.record({
			timestamp: new Date().toISOString(),
			toolName: info.toolName,
			description: info.description.slice(0, DESCRIPTION_LIMIT),
			reasonType: reason.type,
			reasonDetail: reasonDetailOf(decision),
			mode,
			headless: !ctx.hasUI,
		});
	}
}

/** Suggested rule for "allow this session" / "always allow" of the call. */
export function suggestedRule(info: ToolCallInfo): string {
	const tool = capitalizeTool(info.toolName);
	if (info.toolName === "bash" && info.command !== undefined) {
		const command = info.command.trim();
		return command.length > RULE_SUGGESTION_LIMIT
			? `${tool}(${command.slice(0, RULE_SUGGESTION_LIMIT)}...)`
			: `${tool}(${command})`;
	}
	if (info.paths.length > 0) {
		const p = info.paths[0] ?? "";
		return p.length > RULE_SUGGESTION_LIMIT ? `${tool}(${p.slice(0, RULE_SUGGESTION_LIMIT)}...)` : `${tool}(${p})`;
	}
	return tool;
}

function capitalizeTool(toolName: string): string {
	const first = toolName[0] ?? "";
	return first === "" ? toolName : first.toUpperCase() + toolName.slice(1);
}

function reasonDetailOf(decision: Decision): string {
	if (decision.behavior === "ask") return decision.ask.reason;
	if (decision.reason.type === "rule") {
		const v = decision.reason.rule.value;
		return v.ruleContent === undefined ? v.toolName : `${v.toolName}(${v.ruleContent})`;
	}
	return decision.reason.detail;
}

/** Denial message with fix guidance, returned to the model as the tool error. */
function buildDenyMessage(info: ToolCallInfo, decision: Extract<Decision, { behavior: "ask" }>): string {
	return [
		`Permission denied for ${info.toolName}: ${decision.ask.reason}`,
		`To approve this, run the task in interactive mode (pi) and use the permission dialog, or pre-authorize with: pi --permissions-allow "${suggestedRule(info)}"`,
		`Or add the rule to ~/.pi/permissions.json manually.`,
	].join(" ");
}
