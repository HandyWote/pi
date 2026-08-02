import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { PermissionAsk } from "../src/asker.ts";
import { TuiAsker } from "../src/askers/tui.ts";

function setup(selectResult: string | undefined) {
	const select = vi.fn(async () => selectResult);
	const context = { ui: { select }, signal: undefined } as unknown as ExtensionContext;
	const asker = new TuiAsker();
	const permission: PermissionAsk = {
		toolName: "bash",
		description: "rm -rf dist",
		reason: "Command requires approval",
		details: ["rm -rf dist"],
	};
	return { asker, context, select, permission };
}

describe("TuiAsker", () => {
	it("shows description, reason and details in the dialog title", async () => {
		const { asker, context, select, permission } = setup("Deny");
		await asker.ask(permission, context);
		const [title, options] = select.mock.calls[0] as unknown as [string, string[]];
		expect(title).toContain("rm -rf dist");
		expect(title).toContain("Command requires approval");
		expect(title).toContain("Needs approval: rm -rf dist");
		expect(options).toEqual(["Allow once", "Allow this session", "Always allow", "Always deny", "Deny", "Cancel"]);
	});

	it.each([
		["Allow once", "allowOnce"],
		["Allow this session", "allowSession"],
		["Always allow", "alwaysAllow"],
		["Always deny", "alwaysDeny"],
		["Deny", "deny"],
	] as const)("maps option %s to %s", async (option, expected) => {
		const { asker, context, permission } = setup(option);
		const outcome = await asker.ask(permission, context);
		expect(outcome).toEqual({ choice: expected });
	});

	it("returns cancel when the dialog is dismissed", async () => {
		const { asker, context, permission } = setup(undefined);
		const outcome = await asker.ask(permission, context);
		expect(outcome).toEqual({ choice: "cancel" });
	});
});
