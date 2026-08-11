import type { AgentMessage, QueueMode } from "./types.ts";

export type PendingMessageLane = "steer" | "followUp" | "nextTurn" | "immediate";

export interface QueuedAgentMessageOptions {
	key: string;
	resolve: (signal: AbortSignal) => AgentMessage | undefined | Promise<AgentMessage | undefined>;
	onError?: (error: unknown) => void;
}

export interface PendingMessageDrainResult {
	lane?: PendingMessageLane;
	messages: AgentMessage[];
	consumed: boolean;
}

interface PendingMessageEntry {
	id: number;
	lane: PendingMessageLane;
	message: AgentMessage;
	key?: string;
	resolve?: QueuedAgentMessageOptions["resolve"];
	onError?: QueuedAgentMessageOptions["onError"];
	resolverAbortController: AbortController;
	superseded: Promise<void>;
	resolveSuperseded: () => void;
	settled: boolean;
}

type ResolutionOutcome =
	| { kind: "resolved"; message: AgentMessage | undefined }
	| { kind: "failed"; error: unknown }
	| { kind: "superseded" }
	| { kind: "aborted" };

const LANES: readonly PendingMessageLane[] = ["steer", "followUp", "nextTurn", "immediate"];

export class PendingMessageBroker {
	private readonly queues: Record<PendingMessageLane, PendingMessageEntry[]> = {
		steer: [],
		followUp: [],
		nextTurn: [],
		immediate: [],
	};
	private readonly entries = new Map<number, PendingMessageEntry>();
	private readonly latestByKey = new Map<string, PendingMessageEntry>();
	private readonly drainingLanes = new Set<PendingMessageLane>();
	private readonly modes: Record<PendingMessageLane, QueueMode> = {
		steer: "one-at-a-time",
		followUp: "one-at-a-time",
		nextTurn: "all",
		immediate: "one-at-a-time",
	};
	private nextId = 1;

	setMode(lane: "steer" | "followUp", mode: QueueMode): void {
		this.modes[lane] = mode;
	}

	getMode(lane: "steer" | "followUp"): QueueMode {
		return this.modes[lane];
	}

	enqueue(lane: PendingMessageLane, message: AgentMessage, options?: QueuedAgentMessageOptions): number {
		if (options) {
			const previous = this.latestByKey.get(options.key);
			if (previous) this.invalidate(previous);
		}

		let resolveSuperseded = () => {};
		const superseded = new Promise<void>((resolve) => {
			resolveSuperseded = resolve;
		});
		const entry: PendingMessageEntry = {
			id: this.nextId++,
			lane,
			message,
			key: options?.key,
			resolve: options?.resolve,
			onError: options?.onError,
			resolverAbortController: new AbortController(),
			superseded,
			resolveSuperseded,
			settled: false,
		};
		this.entries.set(entry.id, entry);
		if (entry.key) this.latestByKey.set(entry.key, entry);
		this.queues[lane].push(entry);
		return entry.id;
	}

	cancel(key: string): void {
		const entry = this.latestByKey.get(key);
		if (entry) this.invalidate(entry);
	}

	cancelAllKeyed(): void {
		for (const entry of [...this.latestByKey.values()]) this.invalidate(entry);
	}

	clear(lanes: readonly PendingMessageLane[] = LANES): void {
		const selected = new Set(lanes);
		for (const entry of [...this.entries.values()]) {
			if (selected.has(entry.lane)) this.invalidate(entry);
		}
	}

	hasItems(lanes: readonly PendingMessageLane[] = LANES): boolean {
		return lanes.some((lane) => this.queues[lane].length > 0);
	}

	async drain(priorities: readonly PendingMessageLane[], signal: AbortSignal): Promise<PendingMessageDrainResult> {
		for (const lane of priorities) {
			if (this.drainingLanes.has(lane)) {
				throw new Error(`Pending message lane is already being drained: ${lane}`);
			}
		}
		for (const lane of priorities) this.drainingLanes.add(lane);

		const messages: AgentMessage[] = [];
		let selectedLane: PendingMessageLane | undefined;
		let consumed = false;
		try {
			while (!signal.aborted) {
				const entry = this.shiftNext(selectedLane ? [selectedLane] : priorities);
				if (!entry) return { lane: selectedLane, messages, consumed };
				consumed = true;

				const outcome = await this.resolveEntry(entry, signal);
				if (outcome.kind === "aborted") return { lane: selectedLane, messages, consumed };
				if (outcome.kind === "superseded") continue;
				if (outcome.kind === "failed") {
					try {
						entry.onError?.(outcome.error);
					} catch {}
					this.settle(entry);
					continue;
				}

				if (!this.isCurrent(entry)) {
					this.invalidate(entry);
					continue;
				}
				this.settle(entry);
				if (!outcome.message) continue;

				selectedLane ??= entry.lane;
				messages.push(outcome.message);
				if (this.modes[selectedLane] === "one-at-a-time") {
					return { lane: selectedLane, messages, consumed };
				}
			}
			return { lane: selectedLane, messages, consumed };
		} finally {
			for (const lane of priorities) this.drainingLanes.delete(lane);
		}
	}

	async resolve(id: number, signal: AbortSignal): Promise<AgentMessage | undefined> {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		this.queues[entry.lane] = this.queues[entry.lane].filter((queued) => queued !== entry);
		const outcome = await this.resolveEntry(entry, signal);
		if (outcome.kind === "failed") {
			try {
				entry.onError?.(outcome.error);
			} catch {}
		}
		if (outcome.kind !== "resolved" || !this.isCurrent(entry)) {
			this.invalidate(entry);
			return undefined;
		}
		this.settle(entry);
		return outcome.message;
	}

	private shiftNext(priorities: readonly PendingMessageLane[]): PendingMessageEntry | undefined {
		for (const lane of priorities) {
			const entry = this.queues[lane].shift();
			if (entry) return entry;
		}
		return undefined;
	}

	private async resolveEntry(entry: PendingMessageEntry, signal: AbortSignal): Promise<ResolutionOutcome> {
		if (signal.aborted) {
			this.invalidate(entry);
			return { kind: "aborted" };
		}
		if (!entry.resolve) return { kind: "resolved", message: entry.message };

		let resolveAborted = () => {};
		const aborted = new Promise<ResolutionOutcome>((resolve) => {
			resolveAborted = () => resolve({ kind: "aborted" });
		});
		const onAbort = () => {
			entry.resolverAbortController.abort();
			resolveAborted();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const resolution: Promise<ResolutionOutcome> = (async () => {
			try {
				return { kind: "resolved", message: await entry.resolve?.(entry.resolverAbortController.signal) };
			} catch (error) {
				return { kind: "failed", error };
			}
		})();
		try {
			const outcome = await Promise.race<ResolutionOutcome>([
				resolution,
				entry.superseded.then(() => ({ kind: "superseded" })),
				aborted,
			]);
			if (outcome.kind === "aborted") this.invalidate(entry);
			return outcome;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	private isCurrent(entry: PendingMessageEntry): boolean {
		return !entry.settled && (!entry.key || this.latestByKey.get(entry.key) === entry);
	}

	private invalidate(entry: PendingMessageEntry): void {
		if (entry.settled) return;
		entry.resolverAbortController.abort();
		this.settle(entry);
	}

	private settle(entry: PendingMessageEntry): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.resolveSuperseded();
		this.entries.delete(entry.id);
		if (entry.key && this.latestByKey.get(entry.key) === entry) this.latestByKey.delete(entry.key);
		this.queues[entry.lane] = this.queues[entry.lane].filter((queued) => queued !== entry);
	}
}
