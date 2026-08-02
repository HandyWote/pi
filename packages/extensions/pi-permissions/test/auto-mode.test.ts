import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DenialAudit } from "../src/audit.ts";
import { Gate } from "../src/gate.ts";
import { GateHandler, shouldFallbackToPrompt } from "../src/handler.ts";
import { emptyRuleCollection, PermissionRuleStore } from "../src/rules/index.ts";
import { SessionStateImpl } from "../src/state.ts";
import { extractToolCallInfo, type ToolCallInfo } from "../src/tool-input.ts";

const CWD = "/home/user/project";

function bashInfo(command: string): ToolCallInfo {
	return extractToolCallInfo({
		type: "tool_call",
		toolCallId: "c1",
		toolName: "bash",
		input: { command },
	} as never);
}

function classifyStub(result: { block: boolean; reason: string } | undefined) {
	return async () => result;
}

async function gateDecide(
	info: ToolCallInfo,
	classify:
		| ((info: ToolCallInfo, ctx: ExtensionContext) => Promise<{ block: boolean; reason: string } | undefined>)
		| undefined,
	mode: "chat" | "acceptEdits" | "auto" = "auto",
) {
	const gate = new Gate({ parseBashCommand: async (cmd) => ({ kind: "simple", commands: [cmd] }), classify });
	const ctx = {} as ExtensionContext;
	return gate.decide({ info, rules: emptyRuleCollection(), mode, cwd: CWD }, ctx);
}

describe("Gate: auto mode classifier", () => {
	it("allows when the classifier allows", async () => {
		const d = await gateDecide(bashInfo("git status"), classifyStub({ block: false, reason: "safe" }));
		expect(d).toMatchObject({ behavior: "allow", reason: { type: "classifier" } });
	});

	it("denies when the classifier blocks", async () => {
		const d = await gateDecide(bashInfo("rm -rf /"), classifyStub({ block: true, reason: "deletes data" }));
		expect(d).toMatchObject({ behavior: "deny", reason: { type: "classifier", detail: "deletes data" } });
		expect(d.behavior === "deny" && d.message).toContain("deletes data");
	});

	it("falls back to ask when the classifier is unavailable", async () => {
		const d = await gateDecide(bashInfo("git status"), undefined);
		expect(d).toMatchObject({ behavior: "ask", reason: { type: "mode" } });
	});

	it("read tools skip the classifier (allowlist)", async () => {
		const info = extractToolCallInfo({ type: "tool_call", toolCallId: "c2", toolName: "ls", input: {} } as never);
		const classify = vi.fn();
		const d = await gateDecide(info, classify);
		expect(d).toMatchObject({ behavior: "allow" });
		expect(classify).not.toHaveBeenCalled();
	});

	it("edit/write skip the classifier via the acceptEdits fast path", async () => {
		const info = extractToolCallInfo({
			type: "tool_call",
			toolCallId: "c3",
			toolName: "write",
			input: { path: "src/a.ts", content: "x" },
		} as never);
		const classify = vi.fn();
		const d = await gateDecide(info, classify);
		expect(d).toMatchObject({ behavior: "allow", reason: { type: "mode" } });
		expect(classify).not.toHaveBeenCalled();
	});

	it("bash still goes through the classifier in auto mode", async () => {
		const classify = vi.fn(classifyStub({ block: false, reason: "safe" }));
		const d = await gateDecide(bashInfo("git status"), classify);
		expect(d).toMatchObject({ behavior: "allow" });
		expect(classify).toHaveBeenCalledTimes(1);
	});
});

describe("shouldFallbackToPrompt", () => {
	it("falls back after maxConsecutive denials", () => {
		expect(shouldFallbackToPrompt({ consecutiveDenials: 2, totalDenials: 2 })).toBe(false);
		expect(shouldFallbackToPrompt({ consecutiveDenials: 3, totalDenials: 3 })).toBe(true);
	});

	it("falls back after maxTotal denials", () => {
		expect(shouldFallbackToPrompt({ consecutiveDenials: 1, totalDenials: 19 })).toBe(false);
		expect(shouldFallbackToPrompt({ consecutiveDenials: 1, totalDenials: 20 })).toBe(true);
	});
});

describe("GateHandler: denial tracking", () => {
	function setup(options: {
		hasUI: boolean;
		classify: (info: ToolCallInfo, ctx: ExtensionContext) => Promise<{ block: boolean; reason: string } | undefined>;
	}) {
		const state = new SessionStateImpl();
		state.setMode("auto");
		const store = new PermissionRuleStore();
		const audit = new DenialAudit({ logPath: "/nonexistent/denials.jsonl" });
		const gate = new Gate({
			parseBashCommand: async (cmd) => ({ kind: "simple", commands: [cmd] }),
			classify: options.classify,
		});
		const tuiAsker = { ask: vi.fn(async () => ({ choice: "deny" as const })) };
		const handler = new GateHandler({ store, state, audit, gate, tuiAsker });
		const ctx = {
			cwd: CWD,
			hasUI: options.hasUI,
			ui: { select: async () => undefined },
		} as unknown as ExtensionContext;
		return { handler, ctx, state, tuiAsker };
	}

	it("counts classifier denials and allows reset the consecutive counter", async () => {
		const { handler, ctx, state } = setup({
			hasUI: false,
			classify: classifyStub({ block: true, reason: "blocked" }),
		});
		await handler.process(
			{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "rm x" } } as never,
			ctx,
		);
		expect(state.getDenialTracking().consecutiveDenials).toBe(1);
		expect(state.getDenialTracking().totalDenials).toBe(1);

		// An allowed call (read tool allowlist) resets the consecutive counter.
		await handler.process({ type: "tool_call", toolCallId: "c2", toolName: "ls", input: {} } as never, ctx);
		expect(state.getDenialTracking().consecutiveDenials).toBe(0);
		expect(state.getDenialTracking().totalDenials).toBe(1);
	});

	it("headless: keeps denying past the limit (no fallback ask)", async () => {
		const { handler, ctx, state, tuiAsker } = setup({
			hasUI: false,
			classify: classifyStub({ block: true, reason: "blocked" }),
		});
		for (let i = 0; i < 5; i++) {
			const result = (await handler.process(
				{ type: "tool_call", toolCallId: `c${i}`, toolName: "bash", input: { command: "rm x" } } as never,
				ctx,
			)) as { block: boolean };
			expect(result.block).toBe(true);
		}
		expect(state.getDenialTracking().totalDenials).toBe(5);
		expect(tuiAsker.ask).not.toHaveBeenCalled();
	});

	it("interactive: falls back to asking the user past the limit", async () => {
		const { handler, ctx, state, tuiAsker } = setup({
			hasUI: true,
			classify: classifyStub({ block: true, reason: "blocked" }),
		});
		for (let i = 0; i < 2; i++) {
			await handler.process(
				{ type: "tool_call", toolCallId: `c${i}`, toolName: "bash", input: { command: "rm x" } } as never,
				ctx,
			);
		}
		expect(tuiAsker.ask).not.toHaveBeenCalled();
		// Third denial crosses maxConsecutive (3): the asker should be invoked.
		await handler.process(
			{ type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "rm x" } } as never,
			ctx,
		);
		expect(tuiAsker.ask).toHaveBeenCalledTimes(1);
		expect(state.getDenialTracking().totalDenials).toBe(3);
	});
});
