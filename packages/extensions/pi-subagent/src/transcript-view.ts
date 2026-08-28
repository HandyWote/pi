import * as fs from "node:fs";
import type { AgentRecord } from "./types.ts";

/**
 * Incremental JSONL transcript parsing for the subagent detail view.
 *
 * The child process streams agent events to `<rootDir>/transcripts/<agentId>.jsonl`
 * (one JSON event per line). Only `message_end` (assistant and toolResult roles)
 * and `tool_result_end` events carry renderable content; every other line
 * (`stderr`, `stdout`, session header, `agent_settled`, malformed JSON, ...) is
 * ignored as noise.
 */

/** Maximum visible width of a rendered tool-call summary line. */
const MAX_ARG_SUMMARY = 80;
/** Maximum visible width of a rendered tool-result summary line. */
const MAX_RESULT_SUMMARY = 100;
/** Upper bound on cached agents (oldest evicted first). */
const MAX_CACHED_AGENTS = 64;

export interface TranscriptTextItem {
	kind: "text";
	text: string;
	timestamp: number;
}

export interface TranscriptToolCallItem {
	kind: "toolCall";
	name: string;
	summary: string;
	argsJson: string;
	timestamp: number;
}

export interface TranscriptToolResultItem {
	kind: "toolResult";
	summary: string;
	isError: boolean;
	timestamp: number;
}

export type TranscriptItem = TranscriptTextItem | TranscriptToolCallItem | TranscriptToolResultItem;

export interface ToolResultSummary {
	summary: string;
	isError: boolean;
}

interface TranscriptCacheEntry {
	items: TranscriptItem[];
	/** Raw bytes of the trailing incomplete line (before the final newline). */
	pending: Buffer;
	size: number;
	mtimeMs: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Flatten a multi-line value to a single line and cap its visible length. */
function flatten(value: string, limit: number): string {
	const singleLine = value.replace(/\s*\n\s*/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

function stringifyArguments(args: unknown): string {
	if (args === undefined || args === null) return "{}";
	if (typeof args === "string") return args;
	try {
		const json = JSON.stringify(args);
		return json === undefined ? "{}" : json;
	} catch {
		return "{}";
	}
}

/**
 * Short one-line summary of tool call arguments per well-known tool, falling
 * back to compact JSON. Length-capped to a single line (~80 visible chars).
 */
export function summarizeToolArguments(name: string, argsJson: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(argsJson);
	} catch {
		return flatten(argsJson, MAX_ARG_SUMMARY);
	}
	if (typeof parsed === "string") return flatten(parsed, MAX_ARG_SUMMARY);
	if (!isObject(parsed)) return flatten(argsJson, MAX_ARG_SUMMARY);
	const command = asString(parsed.command);
	if (name === "bash" && command) return flatten(command, MAX_ARG_SUMMARY);
	const filePath = asString(parsed.path) ?? asString(parsed.file_path);
	if ((name === "read" || name === "write" || name === "edit") && filePath) return flatten(filePath, MAX_ARG_SUMMARY);
	const pattern = asString(parsed.pattern) ?? asString(parsed.query);
	if ((name === "grep" || name === "rg") && pattern) return flatten(pattern, MAX_ARG_SUMMARY);
	if (name === "agent_start") {
		const tasks = parsed.tasks;
		if (Array.isArray(tasks)) {
			if (tasks.length === 1 && isObject(tasks[0])) {
				const agent = asString(tasks[0].agent);
				if (agent) return flatten(agent, MAX_ARG_SUMMARY);
			}
			if (tasks.length > 1) return `${tasks.length} agents`;
		} else {
			const agent = asString(parsed.agent);
			if (agent) return flatten(agent, MAX_ARG_SUMMARY);
		}
	}
	return flatten(argsJson, MAX_ARG_SUMMARY);
}

function firstTextBlock(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (isObject(part) && part.type === "text") {
			const text = asString(part.text);
			if (text?.trim()) return text;
		}
	}
	return "";
}

/**
 * Flatten the first text block of a tool result to a single line and cap its
 * visible length (~100 chars), carrying the error flag through.
 */
export function summarizeToolResult(content: unknown, isError = false): ToolResultSummary {
	return { summary: flatten(firstTextBlock(content), MAX_RESULT_SUMMARY), isError };
}

function parseMessageEnd(message: unknown): TranscriptItem[] {
	if (!isObject(message)) return [];
	const role = message.role;
	if (role !== "assistant" && role !== "toolResult") return [];
	const timestamp = asNumber(message.timestamp) ?? Date.now();
	if (role === "toolResult") {
		const result = summarizeToolResult(message.content, message.isError === true);
		return [{ kind: "toolResult", summary: result.summary, isError: result.isError, timestamp }];
	}
	const items: TranscriptItem[] = [];
	const content = message.content;
	if (typeof content === "string") {
		if (content.trim()) items.push({ kind: "text", text: content, timestamp });
		return items;
	}
	if (!Array.isArray(content)) return items;
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "text") {
			const text = asString(part.text);
			if (text?.trim()) items.push({ kind: "text", text, timestamp });
		} else if (part.type === "toolCall") {
			const name = asString(part.name);
			if (!name) continue;
			const argsJson = stringifyArguments(part.arguments);
			items.push({
				kind: "toolCall",
				name,
				summary: summarizeToolArguments(name, argsJson),
				argsJson,
				timestamp,
			});
		}
	}
	return items;
}

function parseToolResultEnd(message: unknown): TranscriptItem[] {
	if (!isObject(message)) return [];
	const timestamp = asNumber(message.timestamp) ?? Date.now();
	const result = summarizeToolResult(message.content, message.isError === true);
	return [{ kind: "toolResult", summary: result.summary, isError: result.isError, timestamp }];
}

function parseLine(line: string): TranscriptItem[] {
	const trimmed = line.trim();
	if (!trimmed) return [];
	let event: unknown;
	try {
		event = JSON.parse(trimmed);
	} catch {
		return [];
	}
	if (!isObject(event)) return [];
	if (event.type === "message_end") return parseMessageEnd(event.message);
	if (event.type === "tool_result_end") return parseToolResultEnd(event.message);
	return [];
}

/**
 * Per-agent incremental transcript cache keyed by (path, size, mtime). Each
 * `getItems` call re-reads only the bytes appended since the last call and
 * parses only newly completed lines, carrying the trailing incomplete line as
 * raw bytes so multi-byte UTF-8 characters split across appends stay intact.
 * Returned item lists are append-only snapshots; callers must not mutate them.
 */
export class TranscriptCache {
	private readonly entries = new Map<string, TranscriptCacheEntry>();

	/** Drop all cached entries (e.g. when the parent session state is cleared). */
	clear(): void {
		this.entries.clear();
	}

	async getItems(record: Pick<AgentRecord, "transcriptPath">): Promise<TranscriptItem[]> {
		const filePath = record.transcriptPath;
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(filePath);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.entries.delete(filePath);
				return [];
			}
			throw error;
		}
		const cached = this.entries.get(filePath);
		if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.items;
		// A shorter file means it was replaced or truncated, and a same-size file
		// whose mtime changed was rewritten in place; both restart from the top.
		const reset =
			!cached || stat.size < cached.size || (stat.size === cached.size && stat.mtimeMs !== cached.mtimeMs);
		let data: Buffer;
		if (reset) {
			data = await fs.promises.readFile(filePath);
		} else {
			data = Buffer.allocUnsafe(stat.size - cached.size);
			const fd = await fs.promises.open(filePath, "r");
			try {
				await fd.read(data, 0, data.length, cached.size);
			} finally {
				await fd.close();
			}
		}
		const raw = reset ? data : Buffer.concat([cached.pending, data]);
		const newline = raw.lastIndexOf(0x0a);
		let items: TranscriptItem[];
		let pending: Buffer;
		if (newline < 0) {
			items = reset ? [] : cached.items;
			pending = raw;
		} else {
			const complete = raw.subarray(0, newline).toString("utf8");
			const parsed: TranscriptItem[] = [];
			for (const line of complete.split("\n")) {
				const found = parseLine(line);
				if (found.length > 0) parsed.push(...found);
			}
			items = (reset ? [] : cached.items).concat(parsed);
			pending = raw.subarray(newline + 1);
		}
		this.entries.set(filePath, { items, pending, size: stat.size, mtimeMs: stat.mtimeMs });
		if (this.entries.size > MAX_CACHED_AGENTS) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return items;
	}
}
