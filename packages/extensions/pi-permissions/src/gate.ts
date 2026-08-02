/**
 * The decision engine (gate).
 *
 * Pure logic — no UI, no pi runtime dependency beyond types. Consumes the
 * rule store snapshot, the session state, the redline checker and the bash
 * parser, and produces a Decision. Askers (TUI dialog / headless auto-deny)
 * consume ask decisions; the caller decides which asker to use.
 *
 * Precedence (all modes): redline > deny rules > ask rules > allow rules,
 * then mode behavior (chat auto-allow / acceptEdits / auto classifier).
 */

import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { PermissionAsk } from "./asker.ts";
import type { BashParseResult } from "./bash-analysis/index.ts";
import { checkRedline, type RedlineCheckInput } from "./redline.ts";
import { matchContentRules, matchToolRules, type PermissionRule, type RuleCollection } from "./rules/index.ts";
import type { PermissionMode } from "./state.ts";
import type { ToolCallInfo } from "./tool-input.ts";

export type DecisionReason =
	| { type: "redline"; detail: string }
	| { type: "rule"; rule: PermissionRule }
	| { type: "parser"; detail: string }
	| { type: "mode"; detail: string }
	| { type: "classifier"; detail: string }
	| { type: "allowlist"; detail: string };

export type Decision =
	| { behavior: "allow"; reason: DecisionReason }
	| { behavior: "deny"; reason: DecisionReason; message: string }
	| { behavior: "ask"; reason: DecisionReason; ask: PermissionAsk };

/** Tools that read without writing; auto-allowed in chat/acceptEdits mode. */
export const READ_TOOLS = new Set(["ls", "grep", "find"]);

/** Read tools that can leak sensitive content; still auto-allowed unless redline. */
export const READ_FILE_TOOLS = new Set(["read"]);

/** Write tools affected by acceptEdits mode. */
export const EDIT_TOOLS = new Set(["edit", "write"]);

export interface GateInput {
	info: ToolCallInfo;
	rules: RuleCollection;
	mode: PermissionMode;
	cwd: string;
}

export interface GateDependencies {
	/** bash parser; when unavailable the gate asks on unparseable commands. */
	parseBashCommand?: (command: string) => Promise<BashParseResult>;
	/**
	 * Optional auto-mode classifier (T12). Returns a decision; undefined
	 * means the classifier is unavailable and the gate falls back to ask.
	 */
	classify?: (info: ToolCallInfo, ctx: ExtensionContext) => Promise<{ block: boolean; reason: string } | undefined>;
}

export class Gate {
	private readonly deps: GateDependencies;

	constructor(deps: GateDependencies = {}) {
		this.deps = deps;
	}
	async decide(input: GateInput, ctx: ExtensionContext): Promise<Decision> {
		const { info, rules, mode, cwd } = input;

		// 1. Redline: sensitive paths can never be auto-allowed.
		if (info.paths.length > 0) {
			const operation = isWriteTool(info.toolName) ? "write" : "read";
			const redlineInput: RedlineCheckInput = { toolName: info.toolName, paths: info.paths, cwd, operation };
			const redline = checkRedline(redlineInput);
			if (redline.hit) {
				return {
					behavior: "ask",
					reason: { type: "redline", detail: redline.reason ?? "sensitive path" },
					ask: this.buildAsk(info, `Sensitive path (${redline.reason ?? redline.matchedPath})`),
				};
			}
		}

		// 2. Whole-tool rules.
		const toolVerdict = matchToolRules(rules, info.toolName);
		if (toolVerdict.deny) {
			return denyDecision(toolVerdict.deny, `${info.toolName} is denied by a permission rule`);
		}
		if (toolVerdict.ask) {
			return askDecision(toolVerdict.ask, info, `Denied by rule: ${ruleString(toolVerdict.ask)}`);
		}
		if (toolVerdict.allow) {
			return allowDecision({ type: "rule", rule: toolVerdict.allow });
		}

		// 3. Bash: parse and match per subcommand.
		if (info.toolName === "bash" && info.command !== undefined) {
			const bashDecision = await this.decideBash(info, rules);
			if (bashDecision) return bashDecision;
		}

		// 4. Mode behavior.
		return this.decideByMode(info, mode, ctx);
	}

	private async decideBash(info: ToolCallInfo, rules: RuleCollection): Promise<Decision | null> {
		const command = info.command!;
		if (command.trim() === "") return null;

		const parse = this.deps.parseBashCommand;
		if (!parse) {
			// No parser available: match rules against the whole command, then
			// ask rather than guess.
			return this.ruleOrAsk(info, rules, command, "bash parser unavailable");
		}

		const parsed = await parse(command);
		if (parsed.kind !== "simple") {
			// Unparseable or too complex: rules still apply to the whole
			// command; only fall through to ask if no rule matched.
			return this.ruleOrAsk(info, rules, command, parsed.reason);
		}

		// Clean parse: match rules against each subcommand.
		const denied: PermissionRule[] = [];
		const asked: { rule: PermissionRule; subcommand: string }[] = [];
		const allowed = new Set<string>();

		for (const subcommand of parsed.commands) {
			const verdict = matchContentRules(rules, info.toolName, subcommand.trim());
			if (verdict.deny) denied.push(verdict.deny);
			else if (verdict.ask) asked.push({ rule: verdict.ask, subcommand: subcommand.trim() });
			else if (verdict.allow) allowed.add(subcommand.trim());
		}

		if (denied.length > 0) {
			const rule = denied[0]!;
			return denyDecision(rule, `Subcommand denied by rule: ${ruleString(rule)}`);
		}
		if (asked.length > 0) {
			const rule = asked[0]!.rule;
			return {
				behavior: "ask",
				reason: { type: "rule", rule },
				ask: this.buildAsk(
					info,
					`Subcommand requires approval: ${asked[0]!.subcommand}`,
					asked.map((a) => a.subcommand),
				),
			};
		}
		// All subcommands allowed by rules.
		if (allowed.size === parsed.commands.length && parsed.commands.length > 0) {
			return allowDecision({ type: "rule", rule: allowedRuleFor(info, rules) });
		}

		// Fall through to mode behavior for unruled subcommands.
		return null;
	}

	/**
	 * Match rules against the whole command (used when parsing is
	 * unavailable or too complex); ask when no rule matched.
	 */
	private ruleOrAsk(info: ToolCallInfo, rules: RuleCollection, command: string, parserNote: string): Decision | null {
		const verdict = matchContentRules(rules, info.toolName, command.trim());
		if (verdict.deny) {
			return denyDecision(verdict.deny, `Command denied by rule: ${ruleString(verdict.deny)}`);
		}
		if (verdict.ask) {
			return askDecision(verdict.ask, info, `Subcommand requires approval: ${ruleString(verdict.ask)}`);
		}
		if (verdict.allow) {
			return allowDecision({ type: "rule", rule: verdict.allow });
		}
		return {
			behavior: "ask",
			reason: { type: "parser", detail: parserNote },
			ask: this.buildAsk(info, `Cannot safely analyze this command (${parserNote})`),
		};
	}

	private async decideByMode(info: ToolCallInfo, mode: PermissionMode, ctx: ExtensionContext): Promise<Decision> {
		if (mode === "acceptEdits" && EDIT_TOOLS.has(info.toolName)) {
			return allowDecision({ type: "mode", detail: "acceptEdits mode allows edits" });
		}

		// chat and acceptEdits both auto-allow read-only tools.
		if (READ_TOOLS.has(info.toolName) || READ_FILE_TOOLS.has(info.toolName)) {
			return allowDecision({ type: "allowlist", detail: "read-only tool" });
		}

		if (mode === "auto") {
			// acceptEdits fast path: calls that acceptEdits mode would allow
			// (project edits, redline already checked above) skip the
			// classifier — saves a model call per edit.
			if (EDIT_TOOLS.has(info.toolName)) {
				return allowDecision({ type: "mode", detail: "acceptEdits fast path in auto mode" });
			}
			const verdict = await this.decideAuto(info, ctx);
			if (verdict) return verdict;
		}

		return {
			behavior: "ask",
			reason: { type: "mode", detail: `${mode} mode requires approval` },
			ask: this.buildAsk(info, `Current permission mode (${mode}) requires approval`),
		};
	}

	private async decideAuto(info: ToolCallInfo, ctx: ExtensionContext): Promise<Decision | undefined> {
		const classify = this.deps.classify;
		if (!classify) return undefined;

		const result = await classify(info, ctx);
		if (result === undefined) return undefined;

		if (result.block) {
			return {
				behavior: "deny",
				reason: { type: "classifier", detail: result.reason },
				message: `Permission denied by auto-mode classifier: ${result.reason}`,
			};
		}

		return allowDecision({ type: "classifier", detail: result.reason });
	}

	private buildAsk(info: ToolCallInfo, reason: string, details?: string[]): PermissionAsk {
		return {
			toolName: info.toolName,
			description: info.description,
			reason,
			details,
		};
	}
}

function isWriteTool(toolName: string): boolean {
	return toolName === "edit" || toolName === "write";
}

function ruleString(rule: PermissionRule): string {
	return rule.value.ruleContent === undefined
		? rule.value.toolName
		: `${rule.value.toolName}(${rule.value.ruleContent})`;
}

function denyDecision(rule: PermissionRule, message: string): Decision {
	return { behavior: "deny", reason: { type: "rule", rule }, message };
}

function askDecision(rule: PermissionRule, info: ToolCallInfo, reason: string): Decision {
	return {
		behavior: "ask",
		reason: { type: "rule", rule },
		ask: {
			toolName: info.toolName,
			description: info.description,
			reason,
		},
	};
}

function allowDecision(reason: DecisionReason): Decision {
	return { behavior: "allow", reason };
}

/** Best-effort rule for "allowed by rules" attribution. */
function allowedRuleFor(info: ToolCallInfo, rules: RuleCollection): PermissionRule {
	const tool = matchToolRules(rules, info.toolName);
	if (tool.allow) return tool.allow;
	return { source: "session", behavior: "allow", value: { toolName: info.toolName } };
}
