/**
 * Headless asker: no UI available (print/json/rpc modes).
 *
 * Always auto-denies — the caller composes the denial message with guidance
 * (switch to the TUI, or grant via CLI flags). Rules still apply in these
 * modes; only the "ask the user" channel is replaced by a deterministic
 * fail-closed rejection.
 */

import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { Asker, AskOutcome, PermissionAsk } from "../asker.ts";

export class HeadlessAsker implements Asker {
	async ask(_permission: PermissionAsk, _ctx: ExtensionContext): Promise<AskOutcome> {
		return { choice: "deny" };
	}
}
