/**
 * Interactive asker: modal select dialog (TUI mode).
 *
 * The dialog title carries the command and the reason; the options mirror
 * Claude Code's permission prompt (allow once / session / always / deny).
 */

import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { Asker, AskOutcome, PermissionAsk } from "../asker.ts";

const OPTIONS = ["Allow once", "Allow this session", "Always allow", "Always deny", "Deny", "Cancel"] as const;

export class TuiAsker implements Asker {
	async ask(permission: PermissionAsk, ctx: ExtensionContext): Promise<AskOutcome> {
		const lines = [permission.description, `Reason: ${permission.reason}`];
		if (permission.details && permission.details.length > 0) {
			lines.push(`Needs approval: ${permission.details.join(" | ")}`);
		}
		const choice = await ctx.ui.select(lines.join("\n"), [...OPTIONS], {
			signal: ctx.signal,
		});
		switch (choice) {
			case "Allow once":
				return { choice: "allowOnce" };
			case "Allow this session":
				return { choice: "allowSession" };
			case "Always allow":
				return { choice: "alwaysAllow" };
			case "Always deny":
				return { choice: "alwaysDeny" };
			case "Deny":
				return { choice: "deny" };
			default:
				return { choice: "cancel" };
		}
	}
}
