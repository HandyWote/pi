/**
 * The asker interface: how a "needs approval" decision reaches the user.
 *
 * The decision engine (gate) produces an ask decision; askers consume it.
 * v1 ships two implementations:
 * - TuiAsker:  modal select dialog (interactive mode)
 * - HeadlessAsker: auto-deny with guidance (print/json/rpc modes)
 *
 * Other UI authors can plug in their own asker (e.g. forwarding the request
 * over an RPC channel) without touching the decision engine.
 */

import type { ExtensionContext } from "@handy_wote/pi-coding-agent";

/** What the user can choose when asked for approval. */
export type AskChoice = "allowOnce" | "allowSession" | "alwaysAllow" | "alwaysDeny" | "deny" | "cancel";

export interface AskOutcome {
	choice: AskChoice;
}

export interface PermissionAsk {
	/** Tool name (lowercase, e.g. "bash"). */
	toolName: string;
	/** Human-readable summary of what is being requested. */
	description: string;
	/** Why approval is required (redline, rule, mode, parser, ...). */
	reason: string;
	/** Optional detail lines shown under the reason (e.g. which subcommands need approval). */
	details?: string[];
}

export interface Asker {
	/** Prompt the user. Returns the outcome; cancel means no decision was made. */
	ask(permission: PermissionAsk, ctx: ExtensionContext): Promise<AskOutcome>;
}
