import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeToolArguments, summarizeToolResult, TranscriptCache } from "../src/transcript-view.ts";

const tempRoots: string[] = [];

function temporaryDirectory(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-transcript-"));
	tempRoots.push(root);
	return root;
}

function writeTranscript(root: string, lines: string[]): string {
	const filePath = path.join(root, "transcript.jsonl");
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
	return filePath;
}

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

function record(transcriptPath: string): { transcriptPath: string } {
	return { transcriptPath };
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

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
	it("parses assistant text, tool calls, and tool results into transcript items", async () => {
		const root = temporaryDirectory();
		const filePath = writeTranscript(root, [
			assistantEvent([{ type: "text", text: "Hello there" }], 111),
			assistantEvent(
				[
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
					{ type: "text", text: "Running tests" },
				],
				222,
			),
			toolResultEvent([{ type: "text", text: "All tests passed" }], false, 333),
		]);
		const cache = new TranscriptCache();
		const items = await cache.getItems(record(filePath));

		expect(items).toEqual([
			{ kind: "text", text: "Hello there", timestamp: 111 },
			{ kind: "toolCall", name: "bash", summary: "npm test", argsJson: '{"command":"npm test"}', timestamp: 222 },
			{ kind: "text", text: "Running tests", timestamp: 222 },
			{ kind: "toolResult", summary: "All tests passed", isError: false, timestamp: 333 },
		]);
	});

	it("parses tool_result_end events and marks errors", async () => {
		const root = temporaryDirectory();
		const filePath = writeTranscript(root, [
			JSON.stringify({
				type: "tool_result_end",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "Command failed" }],
					isError: true,
					timestamp: 55,
				},
			}),
		]);
		const cache = new TranscriptCache();
		const items = await cache.getItems(record(filePath));
		expect(items).toEqual([{ kind: "toolResult", summary: "Command failed", isError: true, timestamp: 55 }]);
	});

	it("ignores noise lines: stderr, stdout, header, agent_settled, malformed JSON", async () => {
		const root = temporaryDirectory();
		const filePath = writeTranscript(root, [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "stderr", text: "warning noise", timestamp: 1 }),
			JSON.stringify({ type: "stdout", text: "log noise", timestamp: 2 }),
			JSON.stringify({ type: "agent_settled" }),
			"this is not json",
			assistantEvent([{ type: "text", text: "real" }], 3),
		]);
		const cache = new TranscriptCache();
		const items = await cache.getItems(record(filePath));
		expect(items).toEqual([{ kind: "text", text: "real", timestamp: 3 }]);
	});

	it("ignores non-assistant message_end events (user/custom roles)", async () => {
		const root = temporaryDirectory();
		const filePath = writeTranscript(root, [
			JSON.stringify({ type: "message_end", message: { role: "user", content: "a prompt", timestamp: 1 } }),
			JSON.stringify({ type: "message_end", message: { role: "custom", content: "noise", timestamp: 2 } }),
			assistantEvent([{ type: "text", text: "kept" }], 3),
		]);
		const cache = new TranscriptCache();
		const items = await cache.getItems(record(filePath));
		expect(items).toEqual([{ kind: "text", text: "kept", timestamp: 3 }]);
	});

	it("appends incrementally: only newly completed lines are parsed", async () => {
		const root = temporaryDirectory();
		const filePath = path.join(root, "transcript.jsonl");
		const cache = new TranscriptCache();

		fs.writeFileSync(filePath, `${assistantEvent([{ type: "text", text: "first" }], 10)}\n`, "utf8");
		await touch(filePath);
		expect(await cache.getItems(record(filePath))).toEqual([{ kind: "text", text: "first", timestamp: 10 }]);

		// Simulate an interrupted line append: text split across writes.
		fs.appendFileSync(filePath, `${assistantEvent([{ type: "text", text: "split" }], 20).slice(0, 30)}`, "utf8");
		await touch(filePath);
		expect(await cache.getItems(record(filePath))).toEqual([{ kind: "text", text: "first", timestamp: 10 }]);

		fs.appendFileSync(filePath, `${assistantEvent([{ type: "text", text: "split" }], 20).slice(30)}\n`, "utf8");
		await touch(filePath);
		expect(await cache.getItems(record(filePath))).toEqual([
			{ kind: "text", text: "first", timestamp: 10 },
			{ kind: "text", text: "split", timestamp: 20 },
		]);
	});

	it("keeps a partial trailing line in the buffer across calls", async () => {
		const root = temporaryDirectory();
		const filePath = path.join(root, "transcript.jsonl");
		const cache = new TranscriptCache();

		fs.writeFileSync(filePath, `${assistantEvent([{ type: "text", text: "A" }], 1)}\n{`, "utf8");
		await touch(filePath);
		await cache.getItems(record(filePath));
		// mtime and size unchanged: served from cache without touching the file.
		expect(await cache.getItems(record(filePath))).toEqual([{ kind: "text", text: "A", timestamp: 1 }]);

		fs.appendFileSync(filePath, '"rest"\n}', "utf8");
		await touch(filePath);
		await cache.getItems(record(filePath));
		// The second append never completed a newline, so nothing new is parsed.
		expect(await cache.getItems(record(filePath))).toEqual([{ kind: "text", text: "A", timestamp: 1 }]);

		fs.appendFileSync(filePath, '\n{"type":"agent_settled"}\n', "utf8");
		await touch(filePath);
		const items = await cache.getItems(record(filePath));
		expect(items).toEqual([{ kind: "text", text: "A", timestamp: 1 }]);
	});

	it("keeps multi-byte UTF-8 characters split across appends intact", async () => {
		const root = temporaryDirectory();
		const filePath = path.join(root, "transcript.jsonl");
		const cache = new TranscriptCache();
		const line = assistantEvent([{ type: "text", text: "héllo ✓ world" }], 7);
		const bytes = Buffer.from(line, "utf8");
		// Split one byte into the 3-byte UTF-8 encoding of "✓" so the partial
		// character spans two separate appends.
		const checkmarkOffset = bytes.indexOf(Buffer.from("✓", "utf8"));
		const split = checkmarkOffset + 1;
		fs.writeFileSync(filePath, bytes.subarray(0, split));
		await touch(filePath);
		await cache.getItems(record(filePath));

		fs.appendFileSync(filePath, bytes.subarray(split));
		fs.appendFileSync(filePath, "\n", "utf8");
		await touch(filePath);
		const items = await cache.getItems(record(filePath));
		expect(items).toEqual([{ kind: "text", text: "héllo ✓ world", timestamp: 7 }]);
	});

	it("restarts from the top when the file is truncated or replaced", async () => {
		const root = temporaryDirectory();
		const filePath = path.join(root, "transcript.jsonl");
		const cache = new TranscriptCache();

		fs.writeFileSync(filePath, `${assistantEvent([{ type: "text", text: "old" }], 1)}\n`, "utf8");
		await touch(filePath);
		await cache.getItems(record(filePath));

		// Rewrite with a completely different, shorter transcript. The size
		// shrinks, which forces the cache to restart from the top regardless of
		// mtime granularity (a same-size rewrite can land on the same mtime ms).
		fs.writeFileSync(filePath, `${assistantEvent([{ type: "text", text: "nw" }], 2)}\n`);
		await touch(filePath);
		const items = await cache.getItems(record(filePath));
		expect(items).toEqual([{ kind: "text", text: "nw", timestamp: 2 }]);
	});

	it("returns an empty list for a missing transcript", async () => {
		const root = temporaryDirectory();
		const cache = new TranscriptCache();
		expect(await cache.getItems(record(path.join(root, "missing.jsonl")))).toEqual([]);
	});
});

async function touch(filePath: string): Promise<void> {
	const stat = await fs.promises.stat(filePath);
	const mtime = new Date(stat.mtimeMs + 1000);
	await fs.promises.utimes(filePath, mtime, mtime);
}
