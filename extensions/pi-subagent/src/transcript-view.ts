import type { TranscriptBuffer, TranscriptWindow } from "./transcript-buffer.ts";

/**
 * Incremental JSONL transcript parsing for the subagent detail view.
 *
 * The manager streams agent events into the registry's `TranscriptBuffer`
 * (one complete JSON event per line). Only `message_end` (assistant and
 * toolResult roles) and `tool_result_end` events carry renderable content;
 * every other line (`stderr`, `stdout`, session header, `agent_settled`,
 * malformed JSON, ...) is ignored as noise.
 */

/** Maximum visible width of a rendered tool-call summary line. */
const MAX_ARG_SUMMARY = 80;
/** Maximum visible width of a rendered tool-result summary line. */
const MAX_RESULT_SUMMARY = 100;

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

/** Cursor of an incremental parse: the newest line sequence already parsed. */
interface TranscriptCacheEntry {
	items: TranscriptItem[];
	fromSeq: number;
	/** Buffer generation at parse time; a mismatch forces a full re-parse. */
	generation: number;
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
 * Per-agent incremental transcript cache over the registry's bounded
 * `TranscriptBuffer`. Each `getItems` call parses only the lines appended
 * since the last call (tracked by the buffer's monotonic per-line sequence).
 * When the cursor points at already evicted lines, or the buffer dropped an
 * agent's whole history, the cache restarts from the full remaining buffer so
 * the view stays consistent with what the buffer still holds. Returned item
 * lists are append-only snapshots; callers must not mutate them.
 */
export class TranscriptCache {
	private readonly buffer: TranscriptBuffer;
	private readonly entries = new Map<string, TranscriptCacheEntry>();
	/** Bumped whenever the buffer drops an agent's entire history. */
	private generation = 0;

	constructor(buffer: TranscriptBuffer) {
		this.buffer = buffer;
		buffer.onClear = () => {
			this.generation += 1;
		};
	}

	/** Drop all cached entries (e.g. when the parent session state is cleared). */
	clear(): void {
		this.entries.clear();
	}

	clearAgent(agentId: string): void {
		this.entries.delete(agentId);
	}

	getItems(agentId: string): TranscriptItem[] {
		const cached = this.entries.get(agentId);
		const stale = !cached || cached.generation !== this.generation;
		let window: TranscriptWindow;
		if (!stale) {
			window = this.buffer.getLinesSince(agentId, cached.fromSeq);
		} else {
			// First read: take the full remaining buffer. lastSeq 0 means the cache
			// accepts everything still buffered, mirroring a fresh file read.
			const tail = this.buffer.read(agentId);
			window = {
				lines: tail ? tail.split("\n").filter((line) => line.trim()) : [],
				lastSeq: this.buffer.getLinesSince(agentId, 0).lastSeq,
				evicted: false,
			};
		}
		const parsed: TranscriptItem[] = [];
		for (const line of window.lines) {
			const found = parseLine(line);
			if (found.length > 0) parsed.push(...found);
		}
		let items: TranscriptItem[];
		if (!stale && !window.evicted) {
			items = window.lines.length === 0 ? cached.items : cached.items.concat(parsed);
		} else {
			items = parsed;
		}
		this.entries.set(agentId, { items, fromSeq: window.lastSeq, generation: this.generation });
		return items;
	}
}
