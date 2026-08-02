import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@handy_wote/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPermissionFlags } from "../src/flags.ts";
import { PermissionRuleStore } from "../src/rules/index.ts";
import { SessionStateImpl } from "../src/state.ts";

type FlagOptions = { description?: string; type: "boolean" | "string"; default?: boolean | string };
type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-flags-test-"));
	tempRoots.push(root);
	return root;
}

function setup(flagValues: Record<string, boolean | string | undefined> = {}): {
	api: ExtensionAPI;
	flags: Array<{ name: string; options: FlagOptions }>;
	handlers: Map<string, EventHandler>;
} {
	const flags: Array<{ name: string; options: FlagOptions }> = [];
	const handlers = new Map<string, EventHandler>();
	const api = {
		registerFlag: (name: string, options: FlagOptions) => {
			flags.push({ name, options });
		},
		getFlag: (name: string) => flagValues[name],
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { api, flags, handlers };
}

describe("registerPermissionFlags", () => {
	it("registers the three permission flags as strings", () => {
		const { api, flags } = setup();
		registerPermissionFlags(api, new PermissionRuleStore());
		expect(flags.map((f) => f.name)).toEqual(["permissions-mode", "permissions-allow", "permissions-deny"]);
		for (const flag of flags) expect(flag.options.type).toBe("string");
	});

	it("pushes allow/deny flag values into the CLI rule lists", () => {
		const { api } = setup({
			"permissions-mode": "auto",
			"permissions-allow": "Bash(git:*)",
			"permissions-deny": "Bash(rm *)",
		});
		const store = new PermissionRuleStore();
		registerPermissionFlags(api, store);
		expect(store.cliAllow).toEqual(["Bash(git:*)"]);
		expect(store.cliDeny).toEqual(["Bash(rm *)"]);
		const c = store.collection();
		expect(c.user.allow).toEqual([{ toolName: "Bash", ruleContent: "git:*" }]);
		expect(c.user.deny).toEqual([{ toolName: "Bash", ruleContent: "rm *" }]);
	});

	it("merges CLI rules into the user group ahead of file rules", async () => {
		const { api } = setup({ "permissions-allow": "Bash(git:*)", "permissions-deny": "Bash(rm *)" });
		const root = tempDir();
		const file = path.join(root, "permissions.json");
		fs.writeFileSync(file, JSON.stringify({ allow: ["Edit(.git/*)"], deny: ["Bash(rm -rf *)"] }));
		const store = new PermissionRuleStore({ userRulesPath: file });
		await store.reload();
		registerPermissionFlags(api, store);
		const c = store.collection();
		expect(c.user.allow).toEqual([
			{ toolName: "Bash", ruleContent: "git:*" },
			{ toolName: "Edit", ruleContent: ".git/*" },
		]);
		expect(c.user.deny).toEqual([
			{ toolName: "Bash", ruleContent: "rm *" },
			{ toolName: "Bash", ruleContent: "rm -rf *" },
		]);
	});

	it("ignores empty allow/deny flag values", () => {
		const { api } = setup({ "permissions-allow": "", "permissions-deny": "  " });
		const store = new PermissionRuleStore();
		registerPermissionFlags(api, store);
		expect(store.cliAllow).toEqual([]);
		expect(store.cliDeny).toEqual([]);
	});

	it("applies a valid mode flag on session_start", async () => {
		const { api, handlers } = setup({ "permissions-mode": "auto" });
		const state = new SessionStateImpl();
		registerPermissionFlags(api, new PermissionRuleStore(), () => state);
		const sessionStart = handlers.get("session_start");
		expect(sessionStart).toBeDefined();
		await sessionStart?.({}, { ui: { notify: vi.fn() } });
		expect(state.getMode()).toBe("auto");
	});

	it("does nothing on session_start when the mode flag is unset", async () => {
		const { api, handlers } = setup();
		const state = new SessionStateImpl();
		registerPermissionFlags(api, new PermissionRuleStore(), () => state);
		await handlers.get("session_start")?.({}, { ui: { notify: vi.fn() } });
		expect(state.getMode()).toBe("chat");
	});

	it("warns and ignores an invalid mode flag", async () => {
		const { api, handlers } = setup({ "permissions-mode": "bogus" });
		const state = new SessionStateImpl();
		registerPermissionFlags(api, new PermissionRuleStore(), () => state);
		const notify = vi.fn();
		await handlers.get("session_start")?.({}, { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('--permissions-mode="bogus"'), "warning");
		expect(state.getMode()).toBe("chat");
	});
});
