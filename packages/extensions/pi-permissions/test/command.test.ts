import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@handy_wote/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPermissionsCommand } from "../src/command.ts";
import { PermissionRuleStore } from "../src/rules/index.ts";
import type { DenialTracking, PermissionMode, SessionState } from "../src/state.ts";

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-command-test-"));
	tempRoots.push(root);
	return root;
}

/** SessionState stub with spies, so tests can assert setMode calls. */
class MockState implements SessionState {
	private mode: PermissionMode = "chat";
	setMode = vi.fn((mode: PermissionMode) => {
		this.mode = mode;
	});
	getMode = vi.fn((): PermissionMode => this.mode);
	getDenialTracking = vi.fn((): DenialTracking => ({ consecutiveDenials: 0, totalDenials: 0 }));
	recordDenial = vi.fn((): DenialTracking => ({ consecutiveDenials: 0, totalDenials: 0 }));
	recordSuccess = vi.fn((): DenialTracking => ({ consecutiveDenials: 0, totalDenials: 0 }));
	resetDenialTracking = vi.fn();
	resetSession = vi.fn();
}

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function setup(store: PermissionRuleStore): {
	handler: CommandHandler;
	state: MockState;
	notify: ReturnType<typeof vi.fn>;
} {
	let handler: CommandHandler | undefined;
	const api = {
		registerCommand: (name: string, options: { handler: CommandHandler }) => {
			expect(name).toBe("permissions");
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	const state = new MockState();
	const notify = vi.fn();
	registerPermissionsCommand(api, { store: () => store, state: () => state });
	if (!handler) throw new Error("command handler not registered");
	return { handler, state, notify };
}

async function storeWithRules(rules: { allow?: string[]; deny?: string[]; ask?: string[] }): Promise<{
	store: PermissionRuleStore;
	file: string;
}> {
	const root = tempDir();
	const file = path.join(root, "permissions.json");
	fs.writeFileSync(file, JSON.stringify(rules));
	const store = new PermissionRuleStore({ userRulesPath: file });
	await store.reload();
	return { store, file };
}

function readUserFile(file: string): Record<string, unknown> {
	const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (Array.isArray(value) && value.length === 0) continue;
		out[key] = value;
	}
	return out;
}

describe("/permissions command", () => {
	it("no args shows mode and all rule groups", async () => {
		const { store } = await storeWithRules({
			allow: ["Bash(git:*)", "Edit(.git/*)"],
			deny: ["Bash(rm -rf *)"],
			ask: ["Bash(sudo *)"],
		});
		store.cliAllow.push("Bash(git push)");
		store.addSessionAllow("Bash(npm run build)");
		const { handler, notify } = setup(store);
		await handler("", { ui: { notify } } as unknown as ExtensionCommandContext);
		const message = notify.mock.calls[0]?.[0] as string;
		expect(message).toContain("Mode: chat");
		expect(message).toContain("allow: Bash(git:*), Edit(.git/*)");
		expect(message).toContain("deny: Bash(rm -rf *)");
		expect(message).toContain("ask: Bash(sudo *)");
		expect(message).toContain("allow: Bash(npm run build)");
		expect(message).toContain("allow: Bash(git push)");
		expect(notify).toHaveBeenCalledWith(expect.any(String), "info");
	});

	it("mode switches the session mode", async () => {
		const { store } = await storeWithRules({});
		const { handler, state, notify } = setup(store);
		await handler("mode acceptEdits", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(state.setMode).toHaveBeenCalledWith("acceptEdits");
		expect(state.getMode()).toBe("acceptEdits");
		expect(notify).toHaveBeenCalledWith("Permission mode set to acceptEdits", "info");
	});

	it("invalid mode is rejected without touching state", async () => {
		const { store } = await storeWithRules({});
		const { handler, state, notify } = setup(store);
		await handler("mode bogus", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(state.setMode).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid mode: "bogus"'), "error");
	});

	it("allow adds and persists a rule", async () => {
		const { store, file } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("allow Bash(git:*)", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("Added allow rule: Bash(git:*)", "info");
		expect(readUserFile(file)).toEqual({ allow: ["Bash(git:*)"] });
	});

	it("rule content may contain spaces", async () => {
		const { store, file } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("allow Bash(rm -rf /)", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("Added allow rule: Bash(rm -rf /)", "info");
		expect(readUserFile(file)).toEqual({ allow: ["Bash(rm -rf /)"] });
	});

	it("deny and ask add rules", async () => {
		const { store, file } = await storeWithRules({});
		const { handler } = setup(store);
		await handler("deny Bash(rm *)", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);
		await handler("ask Bash(sudo *)", { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);
		expect(readUserFile(file)).toEqual({ deny: ["Bash(rm *)"], ask: ["Bash(sudo *)"] });
	});

	it("invalid rule is rejected without writing", async () => {
		const { store, file } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("allow not a rule", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid rule: "not a rule"'), "error");
		expect(readUserFile(file)).toEqual({});
	});

	it("missing rule argument is rejected", async () => {
		const { store } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("allow", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Missing rule"), "error");
	});

	it("remove deletes a persisted rule", async () => {
		const { store, file } = await storeWithRules({ allow: ["Bash(git:*)", "Bash(git push)"] });
		const { handler, notify } = setup(store);
		await handler("remove allow Bash(git:*)", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("Removed allow rule: Bash(git:*)", "info");
		expect(readUserFile(file)).toEqual({ allow: ["Bash(git push)"] });
	});

	it("remove of a missing rule reports an error", async () => {
		const { store } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("remove allow Bash(nope)", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("No allow rule: Bash(nope)", "error");
	});

	it("remove with a bad behavior is rejected", async () => {
		const { store } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("remove maybe Bash(git:*)", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("Usage: /permissions remove <allow|deny|ask> <rule>", "error");
	});

	it("session lists session-scoped rules", async () => {
		const { store } = await storeWithRules({});
		store.addSessionAllow("Bash(git:*)");
		const { handler, notify } = setup(store);
		await handler("session", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("allow Bash(git:*)"), "info");
	});

	it("session clear empties session rules", async () => {
		const { store } = await storeWithRules({});
		store.addSessionAllow("Bash(git:*)");
		const { handler, notify } = setup(store);
		await handler("session clear", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("Session rules cleared", "info");
		expect(store.collection().session.allow).toEqual([]);
	});

	it("unknown subcommand shows usage", async () => {
		const { store } = await storeWithRules({});
		const { handler, notify } = setup(store);
		await handler("frobnicate", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "warning");
	});

	it("reports when store or state is unavailable", async () => {
		let handler: CommandHandler | undefined;
		const api = {
			registerCommand: (_name: string, options: { handler: CommandHandler }) => {
				handler = options.handler;
			},
		} as unknown as ExtensionAPI;
		const notify = vi.fn();
		registerPermissionsCommand(api, { store: () => undefined, state: () => undefined });
		await handler?.("", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith("Permission state is unavailable", "error");
	});
});
