import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentActivity, AgentDefinition, AgentRecord, AgentStatus, AgentUsage } from "./types.ts";

interface RegistryFile {
	version: 1;
	parentSessionId: string;
	records: AgentRecord[];
}

export type RegistryCommitter = (filePath: string, data: string) => Promise<void>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return ["queued", "running", "completed", "failed", "stopped", "interrupted"].includes(String(value));
}

function isStringMap(value: unknown): value is Record<string, string> {
	return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isDefinition(value: unknown): value is AgentDefinition {
	return (
		isObject(value) &&
		isIdentifier(value.name) &&
		typeof value.description === "string" &&
		typeof value.systemPrompt === "string" &&
		(value.source === "user" || value.source === "project") &&
		typeof value.filePath === "string" &&
		path.isAbsolute(value.filePath) &&
		(value.isolation === "none" || value.isolation === "worktree") &&
		(value.tools === undefined ||
			(Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string"))) &&
		isOptionalString(value.model) &&
		isOptionalString(value.displayName) &&
		isOptionalString(value.color)
	);
}

function isUsage(value: unknown): value is AgentUsage {
	return (
		isObject(value) &&
		isNonNegativeNumber(value.input) &&
		isNonNegativeNumber(value.output) &&
		isNonNegativeNumber(value.cacheRead) &&
		isNonNegativeNumber(value.cacheWrite) &&
		isNonNegativeNumber(value.cost) &&
		isNonNegativeNumber(value.contextTokens) &&
		Number.isInteger(value.turns) &&
		isNonNegativeNumber(value.turns)
	);
}

function isActivity(value: unknown): value is AgentActivity {
	return (
		isObject(value) &&
		(value.type === "text" || value.type === "tool") &&
		typeof value.text === "string" &&
		isNonNegativeNumber(value.timestamp)
	);
}

function isContained(parent: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function atomicCommit(filePath: string, data: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(temporary, filePath);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}

export class AgentRegistry {
	private records = new Map<string, AgentRecord>();
	private operationQueue: Promise<void> = Promise.resolve();
	private readonly committer: RegistryCommitter;
	readonly parentSessionId: string;
	readonly rootDir: string;
	readonly registryPath: string;

	constructor(rootDir: string, parentSessionId: string, committer: RegistryCommitter = atomicCommit) {
		if (!isIdentifier(parentSessionId)) throw new Error(`Invalid parent session ID: ${parentSessionId}`);
		this.rootDir = path.resolve(rootDir);
		this.parentSessionId = parentSessionId;
		this.registryPath = path.join(this.rootDir, "registries", `${parentSessionId}.json`);
		this.committer = committer;
	}

	load(): Promise<void> {
		return this.enqueue(async () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await fs.promises.readFile(this.registryPath, "utf8"));
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					this.records = new Map();
					return;
				}
				throw new Error(
					`Cannot load subagent registry ${this.registryPath}: ${error instanceof Error ? error.message : error}`,
				);
			}
			if (!isObject(parsed) || parsed.version !== 1 || parsed.parentSessionId !== this.parentSessionId) {
				throw new Error(`Invalid subagent registry: ${this.registryPath}`);
			}
			if (!Array.isArray(parsed.records)) throw new Error(`Invalid subagent records: ${this.registryPath}`);
			const restored = new Map<string, AgentRecord>();
			for (const value of parsed.records) {
				const record = this.validateRecord(value);
				if (restored.has(record.agentId)) throw new Error(`Duplicate agent ID in registry: ${record.agentId}`);
				restored.set(record.agentId, structuredClone(record));
			}
			this.records = restored;
		});
	}

	list(): AgentRecord[] {
		return [...this.records.values()]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((record) => structuredClone(record));
	}

	get(agentId: string): AgentRecord | undefined {
		const record = this.records.get(agentId);
		return record ? structuredClone(record) : undefined;
	}

	save(record: AgentRecord): Promise<void> {
		return this.enqueue(async () => {
			const validated = this.validateRecord(record);
			const next = new Map(this.records);
			next.set(validated.agentId, structuredClone(validated));
			await this.flush(next);
			this.records = next;
		});
	}

	update(agentId: string, mutate: (record: AgentRecord) => AgentRecord): Promise<AgentRecord> {
		return this.enqueue(async () => {
			const current = this.records.get(agentId);
			if (!current) throw new Error(`Unknown agent: ${agentId}`);
			const changed = this.validateRecord(mutate(structuredClone(current)));
			if (changed.agentId !== current.agentId || changed.parentSessionId !== current.parentSessionId) {
				throw new Error("Agent identity cannot be changed");
			}
			const next = new Map(this.records);
			next.set(agentId, structuredClone(changed));
			await this.flush(next);
			this.records = next;
			return structuredClone(changed);
		});
	}

	appendTranscript(agentId: string, event: unknown): Promise<void> {
		return this.enqueue(async () => {
			if (!this.records.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
			const transcriptPath = this.transcriptPath(agentId);
			await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });
			await fs.promises.appendFile(transcriptPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		});
	}

	readTranscript(agentId: string, maxBytes = 200 * 1024): Promise<string> {
		return this.enqueue(async () => {
			if (!this.records.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
			try {
				const data = await fs.promises.readFile(this.transcriptPath(agentId));
				const start = Math.max(0, data.length - maxBytes);
				if (start === 0) return data.toString("utf8");
				const newline = data.indexOf(0x0a, start);
				return newline < 0 ? "" : data.subarray(newline + 1).toString("utf8");
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
				throw error;
			}
		});
	}

	private validateRecord(value: unknown): AgentRecord {
		if (!isObject(value) || value.version !== 1) throw new Error("Invalid agent record version");
		if (!isIdentifier(value.agentId)) throw new Error("Invalid agent ID");
		if (value.parentSessionId !== this.parentSessionId) throw new Error("Agent belongs to another parent session");
		if (!isDefinition(value.definition)) throw new Error(`Invalid definition for agent ${value.agentId}`);
		if (typeof value.task !== "string" || !value.task.trim())
			throw new Error(`Invalid task for agent ${value.agentId}`);
		if (value.mode !== "foreground" && value.mode !== "background")
			throw new Error(`Invalid mode for agent ${value.agentId}`);
		if (!isAgentStatus(value.status)) throw new Error(`Invalid status for agent ${value.agentId}`);
		if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd))
			throw new Error(`Invalid cwd for agent ${value.agentId}`);
		if (value.isolation !== "none" && value.isolation !== "worktree")
			throw new Error(`Invalid isolation for agent ${value.agentId}`);
		if (!isStringMap(value.metadata)) throw new Error(`Invalid metadata for agent ${value.agentId}`);
		if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt))
			throw new Error(`Invalid timestamps for agent ${value.agentId}`);
		if (value.startedAt !== undefined && !isTimestamp(value.startedAt))
			throw new Error(`Invalid start time for agent ${value.agentId}`);
		if (value.endedAt !== undefined && !isTimestamp(value.endedAt))
			throw new Error(`Invalid end time for agent ${value.agentId}`);
		if (value.childSessionId !== value.agentId)
			throw new Error(`Invalid child session ID for agent ${value.agentId}`);
		const expectedSessionDir = path.join(this.rootDir, "sessions", value.agentId);
		const expectedTranscript = this.transcriptPath(value.agentId);
		if (path.resolve(String(value.childSessionDir)) !== expectedSessionDir)
			throw new Error(`Invalid session path for agent ${value.agentId}`);
		if (path.resolve(String(value.transcriptPath)) !== expectedTranscript)
			throw new Error(`Invalid transcript path for agent ${value.agentId}`);
		if (
			value.childSessionPath !== undefined &&
			(typeof value.childSessionPath !== "string" || !isContained(expectedSessionDir, value.childSessionPath))
		) {
			throw new Error(`Invalid child session file for agent ${value.agentId}`);
		}
		if (
			value.worktreePath !== undefined &&
			path.resolve(String(value.worktreePath)) !== path.join(this.rootDir, "worktrees", value.agentId)
		) {
			throw new Error(`Invalid worktree path for agent ${value.agentId}`);
		}
		if (!isUsage(value.usage)) throw new Error(`Invalid usage for agent ${value.agentId}`);
		if (!Number.isInteger(value.toolCount) || !isNonNegativeNumber(value.toolCount))
			throw new Error(`Invalid tool count for agent ${value.agentId}`);
		if (typeof value.lastOutput !== "string") throw new Error(`Invalid output for agent ${value.agentId}`);
		if (!Array.isArray(value.activities) || !value.activities.every(isActivity))
			throw new Error(`Invalid activities for agent ${value.agentId}`);
		if (typeof value.notified !== "boolean") throw new Error(`Invalid notification state for agent ${value.agentId}`);
		if (!isIdentifier(value.lifecycleEventId))
			throw new Error(`Invalid lifecycle event ID for agent ${value.agentId}`);
		if (!isOptionalString(value.error) || !isOptionalString(value.cleanupError) || !isOptionalString(value.model))
			throw new Error(`Invalid optional fields for agent ${value.agentId}`);
		if (
			value.pid !== undefined &&
			(typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)
		) {
			throw new Error(`Invalid pid for agent ${value.agentId}`);
		}
		if (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))) {
			throw new Error(`Invalid exit code for agent ${value.agentId}`);
		}
		return value as unknown as AgentRecord;
	}

	private transcriptPath(agentId: string): string {
		if (!isIdentifier(agentId)) throw new Error(`Invalid agent ID: ${agentId}`);
		return path.join(this.rootDir, "transcripts", `${agentId}.jsonl`);
	}

	private async flush(records: Map<string, AgentRecord>): Promise<void> {
		const data: RegistryFile = {
			version: 1,
			parentSessionId: this.parentSessionId,
			records: [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		};
		await this.committer(this.registryPath, `${JSON.stringify(data, null, 2)}\n`);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation, operation);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
