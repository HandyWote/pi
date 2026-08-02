/**
 * /permissions command: view and change the permission mode and rules.
 *
 * Usage:
 *   /permissions                                  show mode and rules
 *   /permissions mode <chat|acceptEdits|auto>     switch mode
 *   /permissions allow <rule>                     e.g. /permissions allow Bash(git:*)
 *   /permissions deny <rule>
 *   /permissions ask <rule>
 *   /permissions remove <allow|deny|ask> <rule>
 *   /permissions session                          show session-scoped rules
 *   /permissions session clear                    clear session-scoped rules
 *
 * Rule arguments are taken verbatim (they may contain spaces, e.g.
 * `Bash(rm -rf *)`).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@handy_wote/pi-coding-agent";
import { permissionsSummary, showModePicker } from "./mode-picker.ts";
import { parseRuleString, ruleValueToString } from "./rules/index.ts";
import type { PermissionRuleStore } from "./rules/store.ts";
import type { PermissionBehavior } from "./rules/types.ts";
import type { PermissionMode, SessionState } from "./state.ts";

const USAGE = [
	"Usage:",
	"  /permissions",
	"  /permissions mode <chat|acceptEdits|auto>",
	"  /permissions allow <rule>   e.g. /permissions allow Bash(git:*)",
	"  /permissions deny <rule>",
	"  /permissions ask <rule>",
	"  /permissions remove <allow|deny|ask> <rule>",
	"  /permissions session [clear]",
].join("\n");

function isPermissionMode(value: string): value is PermissionMode {
	return value === "chat" || value === "acceptEdits" || value === "auto";
}

function isBehavior(value: string): value is PermissionBehavior {
	return value === "allow" || value === "deny" || value === "ask";
}

function setMode(ctx: ExtensionCommandContext, state: SessionState, value: string): void {
	if (!isPermissionMode(value)) {
		ctx.ui.notify(`Invalid mode: "${value}". Expected "chat", "acceptEdits", or "auto".`, "error");
		return;
	}
	state.setMode(value);
	ctx.ui.notify(`Permission mode set to ${value}`, "info");
}

async function addRule(
	ctx: ExtensionCommandContext,
	store: PermissionRuleStore,
	behavior: PermissionBehavior,
	rule: string,
): Promise<void> {
	if (!rule) {
		ctx.ui.notify(
			`Missing rule. Usage: /permissions ${behavior} <rule>, e.g. /permissions ${behavior} Bash(git:*)`,
			"error",
		);
		return;
	}
	if (!parseRuleString(rule)) {
		ctx.ui.notify(`Invalid rule: "${rule}". Expected ToolName or ToolName(content).`, "error");
		return;
	}
	await store.addUserRule(behavior, rule);
	ctx.ui.notify(`Added ${behavior} rule: ${rule}`, "info");
}

async function removeRule(ctx: ExtensionCommandContext, store: PermissionRuleStore, rest: string): Promise<void> {
	const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
	const behavior = parts?.[1] ?? "";
	const rule = (parts?.[2] ?? "").trim();
	if (!isBehavior(behavior) || !rule) {
		ctx.ui.notify("Usage: /permissions remove <allow|deny|ask> <rule>", "error");
		return;
	}
	const removed = await store.removeUserRule(behavior, rule);
	if (removed) ctx.ui.notify(`Removed ${behavior} rule: ${rule}`, "info");
	else ctx.ui.notify(`No ${behavior} rule: ${rule}`, "error");
}

function sessionRules(ctx: ExtensionCommandContext, store: PermissionRuleStore, rest: string): void {
	if (rest === "clear") {
		store.clearSessionRules();
		ctx.ui.notify("Session rules cleared", "info");
		return;
	}
	if (rest !== "") {
		ctx.ui.notify("Usage: /permissions session [clear]", "error");
		return;
	}
	const session = store.collection().session.allow;
	const lines =
		session.length === 0
			? ["Session rules: none"]
			: ["Session rules:", ...session.map((rule) => `  allow ${ruleValueToString(rule)}`)];
	ctx.ui.notify(lines.join("\n"), "info");
}

export function registerPermissionsCommand(
	pi: ExtensionAPI,
	deps: {
		store: () => PermissionRuleStore | undefined;
		state: () => SessionState | undefined;
	},
): void {
	pi.registerCommand("permissions", {
		description: "View or change permission mode and rules",
		handler: async (args, ctx) => {
			const store = deps.store();
			const state = deps.state();
			if (!store || !state) {
				ctx.ui.notify("Permission state is unavailable", "error");
				return;
			}
			if (args.trim() === "") {
				if (ctx.mode === "tui") {
					await showModePicker(ctx, deps);
					return;
				}
				ctx.ui.notify(permissionsSummary(store, state), "info");
				return;
			}
			const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
			if (!parts) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const verb = parts[1];
			const rest = (parts[2] ?? "").trim();
			switch (verb) {
				case "mode":
					setMode(ctx, state, rest);
					return;
				case "allow":
				case "deny":
				case "ask":
					await addRule(ctx, store, verb, rest);
					return;
				case "remove":
					await removeRule(ctx, store, rest);
					return;
				case "session":
					sessionRules(ctx, store, rest);
					return;
				default:
					ctx.ui.notify(`Unknown /permissions subcommand: ${verb}\n\n${USAGE}`, "warning");
			}
		},
	});
}
