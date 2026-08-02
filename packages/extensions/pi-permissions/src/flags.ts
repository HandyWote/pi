/**
 * CLI flag registration and application (Claude Code's
 * --allowedTools/--disallowedTools equivalent).
 *
 * - --permissions-mode    session mode override (chat | acceptEdits | auto)
 * - --permissions-allow   one-time allow rule, session only, never persisted
 * - --permissions-deny    one-time deny rule, session only, never persisted
 *
 * The mode override is applied on session_start, when session state exists
 * and warnings can be surfaced through the UI.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@handy_wote/pi-coding-agent";
import type { PermissionRuleStore } from "./rules/store.ts";
import type { PermissionMode, SessionState } from "./state.ts";

const PERMISSION_MODES: readonly PermissionMode[] = ["chat", "acceptEdits", "auto"];

function isPermissionMode(value: string): value is PermissionMode {
	return PERMISSION_MODES.includes(value as PermissionMode);
}

export function registerPermissionFlags(
	pi: ExtensionAPI,
	store: PermissionRuleStore,
	getState: () => SessionState | undefined = () => undefined,
): void {
	pi.registerFlag("permissions-mode", {
		description: 'Session permission mode override: "chat", "acceptEdits", or "auto"',
		type: "string",
	});
	pi.registerFlag("permissions-allow", {
		description: 'One-time allow rule, e.g. "Bash(git:*)" (session only, not persisted)',
		type: "string",
	});
	pi.registerFlag("permissions-deny", {
		description: 'One-time deny rule, e.g. "Bash(rm -rf *)" (session only, not persisted)',
		type: "string",
	});

	// One-time rules and mode override are read on session_start: flagValues
	// are injected into the extension runtime only when the AgentSession is
	// built, which happens after the factory runs.
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		const allow = pi.getFlag("permissions-allow");
		if (typeof allow === "string" && allow.trim() !== "" && !store.cliAllow.includes(allow)) {
			store.cliAllow.push(allow);
		}
		const deny = pi.getFlag("permissions-deny");
		if (typeof deny === "string" && deny.trim() !== "" && !store.cliDeny.includes(deny)) {
			store.cliDeny.push(deny);
		}

		const modeFlag = pi.getFlag("permissions-mode");
		if (typeof modeFlag !== "string" || modeFlag.trim() === "") return;
		const state = getState();
		if (!state) return;
		const mode = modeFlag.trim();
		if (isPermissionMode(mode)) {
			state.setMode(mode);
			return;
		}
		ctx.ui.notify(`Ignoring --permissions-mode="${mode}": expected "chat", "acceptEdits", or "auto"`, "warning");
	});
}
