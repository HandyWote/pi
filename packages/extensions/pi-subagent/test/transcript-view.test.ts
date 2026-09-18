import { describe, expect, it } from "vitest";
import { TranscriptBuffer } from "../src/transcript-buffer.ts";
import {
	summarizeToolArguments,
	summarizeToolResult,
	TranscriptCache,
	type TranscriptItem,
} from "../src/transcript-view.ts";

function assistantEvent(content: unknown, timestamp = 1000): string {
	return JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content, usage: { totalTokens: 1 }, timestamp },
	});
}

function toolResultEvent(content: unknown, isError = false, timestamp = 1000): string {
	return JSON.stringify({
		type: "message_end",
		message: { role: "toolResult", content, isError, timestamp },
	});
}

describe("summarizeToolArguments", () => {
	it("summarizes bash by its first command line and flattens multi-line commands", () => {
		expect(summarizeToolArguments("bash", JSON.stringify({ command: "echo hello\nworld" }))).toBe("echo hello world");
	});

	it("summarizes read/write/edit by path", () => {
		expect(summarizeToolArguments("read", JSON.stringify({ path: "src/main.ts" }))).toBe("src/main.ts");
		expect(summarizeToolArguments("write", JSON.stringify({ file_path: "docs/api.md" }))).toBe("docs/api.md");
		expect(summarizeToolArguments("edit", JSON.stringify({ path: "lib/util.ts", edits: [] }))).toBe("lib/util.ts");
	});

	it("summarizes grep/rg by pattern", () => {
		expect(summarizeToolArguments("grep", JSON.stringify({ pattern: "TODO" }))).toBe("TODO");
		expect(summarizeToolArguments("rg", JSON.stringify({ query: "async" }))).toBe("async");
	});

	it("summarizes agent_start by the agent name or task count", () => {
		expect(summarizeToolArguments("agent_start", JSON.stringify({ agent: "worker" }))).toBe("worker");
		expect(summarizeToolArguments("agent_start", JSON.stringify({ tasks: [{ agent: "explore" }] }))).toBe("explore");
		expect(summarizeToolArguments("agent_start", JSON.stringify({ tasks: [{ agent: "a" }, { agent: "b" }] }))).toBe(
			"2 agents",
		);
	});

	it("falls back to compact JSON and truncates to ~80 visible chars", () => {
		const long = "x".repeat(200);
		const summary = summarizeToolArguments("custom", JSON.stringify({ value: long }));
		expect(summary.length).toBeLessThanOrEqual(80);
		expect(summary.endsWith("...")).toBe(true);
		expect(summary).toContain(long.slice(0, 40));
	});

	it("flattens string arguments before truncating", () => {
		expect(summarizeToolArguments("bash", JSON.stringify("raw string"))).toBe("raw string");
		expect(summarizeToolArguments("bash", JSON.stringify("x".repeat(200)))).toBe(`${"x".repeat(77)}...`);
	});
});

describe("summarizeToolResult", () => {
	it("flattens the first text block and truncates to ~100 chars", () => {
		const long = "y".repeat(250);
		const result = summarizeToolResult([{ type: "text", text: `line1\n${long}` }]);
		expect(result.summary.length).toBeLessThanOrEqual(100);
		expect(result.summary.startsWith("line1")).toBe(true);
		expect(result.summary.endsWith("...")).toBe(true);
		expect(result.isError).toBe(false);
	});

	it("carries the error flag through", () => {
		expect(summarizeToolResult("boom", true).isError).toBe(true);
		expect(summarizeToolResult("fine", false).isError).toBe(false);
	});

	it("handles string content and empty content", () => {
		expect(summarizeToolResult("plain text").summary).toBe("plain text");
		expect(summarizeToolResult([]).summary).toBe("");
	});
});

describe("TranscriptCache", () => {
	it("parses assistant text, tool calls, and tool results into transcript items", () => {
		const buffer = new TranscriptBuffer();
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "Hello there" }], 111));
		buffer.append(
			"agent-1",
			assistantEvent(
				[
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
					{ type: "text", text: "Running tests" },
				],
				222,
			),
		);
		buffer.append("agent-1", toolResultEvent([{ type: "text", text: "All tests passed" }], false, 333));
		const cache = new TranscriptCache(buffer);

		expect(cache.getItems("agent-1")).toEqual([
			{ kind: "text", text: "Hello there", timestamp: 111 },
			{ kind: "toolCall", name: "bash", summary: "npm test", argsJson: '{"command":"npm test"}', timestamp: 222 },
			{ kind: "text", text: "Running tests", timestamp: 222 },
			{ kind: "toolResult", summary: "All tests passed", isError: false, timestamp: 333 },
		]);
	});

	it("parses tool_result_end events and marks errors", () => {
		const buffer = new TranscriptBuffer();
		buffer.append(
			"agent-1",
			JSON.stringify({
				type: "tool_result_end",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "Command failed" }],
					isError: true,
					timestamp: 55,
				},
			}),
		);
		const cache = new TranscriptCache(buffer);
		expect(cache.getItems("agent-1")).toEqual([
			{ kind: "toolResult", summary: "Command failed", isError: true, timestamp: 55 },
		]);
	});

	it("ignores noise lines: stderr, stdout, header, agent_settled, malformed JSON", () => {
		const buffer = new TranscriptBuffer();
		buffer.append("agent-1", JSON.stringify({ type: "session", id: "s1" }));
		buffer.append("agent-1", JSON.stringify({ type: "stderr", text: "warning noise", timestamp: 1 }));
		buffer.append("agent-1", JSON.stringify({ type: "stdout", text: "log noise", timestamp: 2 }));
		buffer.append("agent-1", JSON.stringify({ type: "agent_settled" }));
		buffer.append("agent-1", "this is not json");
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "real" }], 3));
		const cache = new TranscriptCache(buffer);

		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "real", timestamp: 3 }]);
	});

	it("ignores non-assistant message_end events (user/custom roles)", () => {
		const buffer = new TranscriptBuffer();
		buffer.append(
			"agent-1",
			JSON.stringify({ type: "message_end", message: { role: "user", content: "a prompt", timestamp: 1 } }),
		);
		buffer.append(
			"agent-1",
			JSON.stringify({ type: "message_end", message: { role: "custom", content: "noise", timestamp: 2 } }),
		);
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "kept" }], 3));
		const cache = new TranscriptCache(buffer);

		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "kept", timestamp: 3 }]);
	});

	it("parses incrementally as lines are appended", () => {
		const buffer = new TranscriptBuffer();
		const cache = new TranscriptCache(buffer);

		buffer.append("agent-1", assistantEvent([{ type: "text", text: "first" }], 10));
		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "first", timestamp: 10 }]);

		buffer.append("agent-1", assistantEvent([{ type: "text", text: "second" }], 20));
		expect(cache.getItems("agent-1")).toEqual([
			{ kind: "text", text: "first", timestamp: 10 },
			{ kind: "text", text: "second", timestamp: 20 },
		]);
	});

	it("serves a stable snapshot when no new lines arrived", () => {
		const buffer = new TranscriptBuffer();
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "A" }], 1));
		const cache = new TranscriptCache(buffer);
		const first = cache.getItems("agent-1");
		expect(first).toEqual([{ kind: "text", text: "A", timestamp: 1 }]);
		expect(cache.getItems("agent-1")).toBe(first);
	});

	it("restarts from the full buffer when the cursor points at evicted lines", () => {
		const buffer = new TranscriptBuffer();
		const cache = new TranscriptCache(buffer);
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "old" }], 1));
		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "old", timestamp: 1 }]);

		// One huge line pushes every earlier line out of the 200KB buffer.
		const huge = assistantEvent([{ type: "text", text: `new ${"x".repeat(210_000)}` }], 2);
		buffer.append("agent-1", huge);
		const items = cache.getItems("agent-1");
		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("text");
		// The snapshot was rebuilt from the remaining buffer, not appended to.
		expect((items[0] as Extract<TranscriptItem, { kind: "text" }>).text.startsWith("new ")).toBe(true);
		expect(cache.getItems("agent-1")).toEqual(items);
	});

	it("keeps per-agent state isolated", () => {
		const buffer = new TranscriptBuffer();
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "one" }], 1));
		buffer.append("agent-2", assistantEvent([{ type: "text", text: "two" }], 2));
		const cache = new TranscriptCache(buffer);

		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "one", timestamp: 1 }]);
		expect(cache.getItems("agent-2")).toEqual([{ kind: "text", text: "two", timestamp: 2 }]);
	});

	it("returns an empty list for unknown agents", () => {
		const cache = new TranscriptCache(new TranscriptBuffer());
		expect(cache.getItems("missing")).toEqual([]);
	});

	it("drops cached state on clear()", () => {
		const buffer = new TranscriptBuffer();
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "A" }], 1));
		const cache = new TranscriptCache(buffer);
		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "A", timestamp: 1 }]);

		buffer.clear("agent-1");
		buffer.append("agent-1", assistantEvent([{ type: "text", text: "B" }], 2));
		expect(cache.getItems("agent-1")).toEqual([{ kind: "text", text: "B", timestamp: 2 }]);
	});
});
