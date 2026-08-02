import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, Theme } from "@handy_wote/pi-coding-agent";
import type { EntityListItem } from "@handy_wote/pi-tui";
import { EntityList } from "@handy_wote/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModePickerItems, MODE_DESCRIPTIONS, permissionsSummary, showModePicker } from "../src/mode-picker.ts";
import { PermissionRuleStore } from "../src/rules/index.ts";
import type { DenialTracking, PermissionMode, SessionState } from "../src/state.ts";

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-picker-test-"));
	tempRoots.push(root);
	return root;
}

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

const mockTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

type CustomFactory = (tui: unknown, theme: Theme, keybindings: unknown, done: () => void) => EntityList;

function setup(): {
	state: MockState;
	store: PermissionRuleStore;
	notify: ReturnType<typeof vi.fn>;
	done: ReturnType<typeof vi.fn>;
	mount: () => { root: EntityList; list: EntityList };
} {
	let capturedFactory: CustomFactory | undefined;
	const state = new MockState();
	const store = new PermissionRuleStore();
	const notify = vi.fn();
	const done = vi.fn();
	const ctx = {
		mode: "tui",
		ui: {
			custom: vi.fn(async (factory: CustomFactory) => {
				capturedFactory = factory;
			}),
			notify,
		},
	} as unknown as ExtensionCommandContext;
	void showModePicker(ctx, { store: () => store, state: () => state });
	if (!capturedFactory) throw new Error("custom factory not captured");
	return {
		state,
		store,
		notify,
		done,
		mount: () => {
			const root = capturedFactory?.({} as never, mockTheme, {} as never, done);
			if (!root) throw new Error("factory returned no component");
			return { root, list: root };
		},
	};
}

describe("buildModePickerItems", () => {
	it("lists the three modes with descriptions and marks the current one", () => {
		const items = buildModePickerItems("acceptEdits");
		expect(items.map((i) => i.id)).toEqual(["chat", "acceptEdits", "auto", "view-rules"]);
		const acceptEdits = items[1];
		expect(acceptEdits?.description).toContain("(current)");
		expect(acceptEdits?.description).toContain(MODE_DESCRIPTIONS.acceptEdits);
		const chat = items[0];
		expect(chat?.description).toBe(MODE_DESCRIPTIONS.chat);
		expect(items[3]).toMatchObject({ id: "view-rules", label: "View rules" });
	});
});

describe("permissionsSummary", () => {
	it("shows mode, user, session and CLI rule groups", async () => {
		const root = tempDir();
		const file = path.join(root, "permissions.json");
		fs.writeFileSync(file, JSON.stringify({ allow: ["Bash(git:*)"], deny: ["Bash(rm -rf *)"] }));
		const store = new PermissionRuleStore({ userRulesPath: file });
		await store.reload();
		store.cliAllow.push("Bash(git push)");
		store.addSessionAllow("Bash(npm run build)");
		const state = new MockState();
		const summary = permissionsSummary(store, state);
		expect(summary).toContain("Mode: chat");
		expect(summary).toContain("allow: Bash(git:*)");
		expect(summary).toContain("deny: Bash(rm -rf *)");
		expect(summary).toContain("allow: Bash(npm run build)");
		expect(summary).toContain("allow: Bash(git push)");
	});
});

describe("showModePicker", () => {
	it("renders an EntityList with the mode items and current mode selected", () => {
		const { state, mount } = setup();
		state.setMode("auto");
		const { list } = mount();
		expect(list).toBeInstanceOf(EntityList);
		expect(list.onActivate).toBeDefined();
		expect(list.onCancel).toBeDefined();
	});

	it("sets the mode and closes on activate", () => {
		const { state, notify, done, mount } = setup();
		const { list } = mount();
		list.onActivate?.({ id: "acceptEdits", label: "acceptEdits" } as EntityListItem);
		expect(state.setMode).toHaveBeenCalledWith("acceptEdits");
		expect(notify).toHaveBeenCalledWith("Permission mode set to acceptEdits", "info");
		expect(done).toHaveBeenCalled();
	});

	it("shows the rules summary and closes on View rules activate", () => {
		const { state, store, notify, done, mount } = setup();
		store.addSessionAllow("Bash(npm run build)");
		const { list } = mount();
		list.onActivate?.({ id: "view-rules", label: "View rules" } as EntityListItem);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Mode: chat"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("allow: Bash(npm run build)"), "info");
		expect(state.setMode).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalled();
	});

	it("closes without changes on cancel", () => {
		const { state, notify, done, mount } = setup();
		const { list } = mount();
		list.onCancel?.();
		expect(state.setMode).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalled();
	});
});
