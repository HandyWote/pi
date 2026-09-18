/**
 * In-memory bounded transcript storage for subagents.
 *
 * The manager appends one complete JSONL line per child event; lines are never
 * partial because callers only append finished event lines. Each agent's
 * buffer keeps the most recent lines under a fixed byte cap, evicting the
 * oldest lines first (FIFO). Sequence numbers are per agent, monotonic, and
 * survive eviction so incremental readers can detect that lines they have not
 * seen were dropped and must re-read the full remaining window.
 */

/** Hard byte cap per agent transcript (including one newline per line). */
export const MAX_TRANSCRIPT_BYTES = 200_000;

interface TranscriptEntry {
	/** Complete lines, oldest first. */
	lines: string[];
	/** Sequence number of the line at the same index in `lines`. */
	seqs: number[];
	/** Total bytes of all lines, counting one trailing newline per line. */
	bytes: number;
	/** Sequence number the next appended line receives (monotonic, eviction-proof). */
	nextSeq: number;
}

export interface TranscriptWindow {
	/** Complete lines newer than the requested cursor, oldest first. */
	lines: string[];
	/** Sequence number of the newest buffered line (0 when the buffer is empty). */
	lastSeq: number;
	/**
	 * True when the requested cursor points at already evicted lines (or an
	 * unknown/cleared agent); `lines` then contains the full remaining buffer.
	 */
	evicted: boolean;
}

function lineBytes(line: string): number {
	return Buffer.byteLength(line, "utf8") + 1;
}

export class TranscriptBuffer {
	private readonly entries = new Map<string, TranscriptEntry>();
	/** Invoked whenever an agent's whole history is dropped; used by view caches to reset. */
	onClear: () => void = () => {};

	/** Append one complete line for an agent, evicting oldest lines over the byte cap. */
	append(agentId: string, line: string): void {
		if (!line) return;
		let entry = this.entries.get(agentId);
		if (!entry) {
			entry = { lines: [], seqs: [], bytes: 0, nextSeq: 1 };
			this.entries.set(agentId, entry);
		}
		entry.lines.push(line);
		entry.seqs.push(entry.nextSeq);
		entry.nextSeq += 1;
		entry.bytes += lineBytes(line);
		// The newest line always survives even when it alone exceeds the cap, so
		// the latest event is never lost (the tail window may exceed the cap).
		while (entry.lines.length > 1 && entry.bytes > MAX_TRANSCRIPT_BYTES) {
			const oldest = entry.lines.shift()!;
			entry.seqs.shift();
			entry.bytes -= lineBytes(oldest);
		}
	}

	/**
	 * Tail window of complete lines within `maxBytes` bytes, matching the
	 * previous file-based `readTranscript` semantics: walk from the newest line
	 * backwards until the accumulated size reaches `maxBytes`, including the
	 * line that crosses the threshold. Unknown agents yield "".
	 */
	read(agentId: string, maxBytes = MAX_TRANSCRIPT_BYTES): string {
		const entry = this.entries.get(agentId);
		if (!entry || entry.lines.length === 0) return "";
		let total = 0;
		let start = entry.lines.length;
		while (start > 0) {
			total += lineBytes(entry.lines[start - 1]!);
			start -= 1;
			if (total >= maxBytes) break;
		}
		return `${entry.lines.slice(start).join("\n")}\n`;
	}

	/**
	 * Lines newer than `fromSeq` for incremental readers. When `fromSeq` points
	 * at evicted lines (or the agent is unknown/cleared), the full remaining
	 * buffer is returned with `evicted: true` so readers can reset their state.
	 */
	getLinesSince(agentId: string, fromSeq: number): TranscriptWindow {
		const entry = this.entries.get(agentId);
		if (!entry || entry.lines.length === 0) return { lines: [], lastSeq: 0, evicted: fromSeq > 0 };
		const lastSeq = entry.nextSeq - 1;
		if (fromSeq < entry.seqs[0]!) return { lines: [...entry.lines], lastSeq, evicted: fromSeq > 0 };
		let index = 0;
		while (index < entry.lines.length && entry.seqs[index]! <= fromSeq) index += 1;
		return { lines: entry.lines.slice(index), lastSeq, evicted: false };
	}

	clear(agentId: string): void {
		if (!this.entries.delete(agentId)) return;
		this.onClear();
	}

	clearAll(): void {
		if (this.entries.size === 0) return;
		this.entries.clear();
		this.onClear();
	}
}
