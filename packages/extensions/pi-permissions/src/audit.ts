/**
 * Denial audit log for the permission gate.
 *
 * Every denied tool call is appended as one JSON line to a JSONL file
 * (default `~/.pi/permissions/denials.jsonl`). The audit is best-effort:
 * write failures are logged to stderr and swallowed so an audit problem
 * can never block the gating flow itself. The file is capped at
 * `maxLines` lines (default 5000); when the cap is exceeded the oldest
 * half is dropped by rewriting the file with the newest `maxLines / 2`
 * lines. Concurrent `record()` calls are serialized through a module-level
 * promise chain so appends and truncations never interleave.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface DenialRecord {
	/** ISO 8601 timestamp of the denial. */
	timestamp: string;
	toolName: string;
	/** Command or path summary, truncated to 500 characters. */
	description: string;
	/** "redline" | "rule" | "parser" | "mode" | "classifier" | "asyncAgent". */
	reasonType: string;
	/** Human-readable reason for the denial. */
	reasonDetail: string;
	/** "chat" | "acceptEdits" | "auto". */
	mode: string;
	/** True when the denial was made headlessly, without a UI prompt. */
	headless: boolean;
}

export interface DenialAuditOptions {
	/** Log file path. Defaults to ~/.pi/permissions/denials.jsonl. */
	logPath?: string;
	/** Maximum number of lines kept in the log before truncation. Default 5000. */
	maxLines?: number;
}

const DEFAULT_LOG_PATH = path.join(os.homedir(), ".pi", "permissions", "denials.jsonl");
const DEFAULT_MAX_LINES = 5000;
const MAX_DESCRIPTION_LENGTH = 500;

/** Serializes all writes (append + truncate) across every DenialAudit instance. */
let writeChain: Promise<void> = Promise.resolve();

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isDenialRecord(value: unknown): value is DenialRecord {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.timestamp === "string" &&
		typeof v.toolName === "string" &&
		typeof v.description === "string" &&
		typeof v.reasonType === "string" &&
		typeof v.reasonDetail === "string" &&
		typeof v.mode === "string" &&
		typeof v.headless === "boolean"
	);
}

export class DenialAudit {
	private readonly logPath: string;
	private readonly maxLines: number;

	constructor(options: DenialAuditOptions = {}) {
		this.logPath = options.logPath ?? DEFAULT_LOG_PATH;
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	}

	/**
	 * Appends one JSON line for the denial. Never rejects: failures are
	 * reported to stderr and dropped so the caller's gating flow proceeds.
	 */
	record(entry: DenialRecord): Promise<void> {
		const line = `${JSON.stringify({ ...entry, description: entry.description.slice(0, MAX_DESCRIPTION_LENGTH) })}\n`;
		const task = writeChain.then(async () => {
			try {
				await this.appendLine(line);
			} catch (err) {
				console.error(`[pi-permissions] denial audit write failed: ${errorMessage(err)}`);
			}
		});
		writeChain = task;
		return task;
	}

	/**
	 * Returns the last `limit` (default 50) valid records, newest last.
	 * Unparsable lines and lines that do not match the record shape are
	 * skipped. Returns an empty array when the log does not exist.
	 */
	async recent(limit = 50): Promise<DenialRecord[]> {
		let content: string;
		try {
			content = await fsp.readFile(this.logPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			console.error(`[pi-permissions] denial audit read failed: ${errorMessage(err)}`);
			return [];
		}
		const records: DenialRecord[] = [];
		for (const line of content.split("\n")) {
			if (line.length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isDenialRecord(parsed)) records.push(parsed);
			} catch {
				// Skip malformed lines (e.g. a torn write or hand-edited log).
			}
		}
		return records.slice(-limit);
	}

	private async appendLine(line: string): Promise<void> {
		await fsp.mkdir(path.dirname(this.logPath), { recursive: true });
		await fsp.appendFile(this.logPath, line, "utf8");
		await this.maybeTruncate();
	}

	/**
	 * When the log exceeds maxLines, rewrites it keeping only the newest
	 * maxLines / 2 lines. Runs after every append; files near the cap are
	 * small so the read-and-rewrite cost stays bounded.
	 */
	private async maybeTruncate(): Promise<void> {
		const content = await fsp.readFile(this.logPath, "utf8");
		const lines = content.split("\n");
		// Our appends always end with "\n"; drop the empty trailing element.
		if (lines.at(-1) === "") lines.pop();
		if (lines.length <= this.maxLines) return;
		const kept = lines.slice(-Math.floor(this.maxLines / 2));
		await fsp.writeFile(this.logPath, `${kept.join("\n")}\n`, "utf8");
	}
}
