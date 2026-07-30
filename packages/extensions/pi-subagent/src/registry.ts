import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRecord, AgentStatus } from "./types.ts";

interface RegistryFile {
	version: 1;
	parentSessionId: string;
	records: AgentRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return ["queued", "running", "completed", "failed", "stopped", "interrupted"].includes(String(value));
}

function isAgentRecord(value: unknown): value is AgentRecord {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.agentId === "string" &&
		typeof value.parentSessionId === "string" &&
		isAgentStatus(value.status) &&
		isRecord(value.definition) &&
		typeof value.transcriptPath === "string"
	);
}

export class AgentRegistry {
	private readonly records = new Map<string, AgentRecord>();
	readonly parentSessionId: string;
	readonly rootDir: string;
	readonly registryPath: string;

	constructor(rootDir: string, parentSessionId: string) {
		this.rootDir = rootDir;
		this.parentSessionId = parentSessionId;
		this.registryPath = path.join(rootDir, "registries", `${parentSessionId}.json`);
	}

	async load(): Promise<void> {
		this.records.clear();
		let parsed: unknown;
		try {
			parsed = JSON.parse(await fs.promises.readFile(this.registryPath, "utf8"));
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new Error(
				`Cannot load subagent registry ${this.registryPath}: ${error instanceof Error ? error.message : error}`,
			);
		}
		if (!isRecord(parsed) || parsed.version !== 1 || parsed.parentSessionId !== this.parentSessionId) {
			throw new Error(`Invalid subagent registry: ${this.registryPath}`);
		}
		if (!Array.isArray(parsed.records) || !parsed.records.every(isAgentRecord)) {
			throw new Error(`Invalid subagent records: ${this.registryPath}`);
		}
		for (const record of parsed.records) this.records.set(record.agentId, record);
	}

	list(): AgentRecord[] {
		return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	get(agentId: string): AgentRecord | undefined {
		return this.records.get(agentId);
	}

	async save(record: AgentRecord): Promise<void> {
		if (record.parentSessionId !== this.parentSessionId) throw new Error("Agent belongs to another parent session");
		this.records.set(record.agentId, record);
		await this.flush();
	}

	async update(agentId: string, mutate: (record: AgentRecord) => AgentRecord): Promise<AgentRecord> {
		const current = this.records.get(agentId);
		if (!current) throw new Error(`Unknown agent: ${agentId}`);
		const next = mutate(current);
		this.records.set(agentId, next);
		await this.flush();
		return next;
	}

	async appendTranscript(agentId: string, event: unknown): Promise<void> {
		const record = this.records.get(agentId);
		if (!record) throw new Error(`Unknown agent: ${agentId}`);
		await fs.promises.mkdir(path.dirname(record.transcriptPath), { recursive: true });
		await fs.promises.appendFile(record.transcriptPath, `${JSON.stringify(event)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	async readTranscript(agentId: string, maxBytes = 200 * 1024): Promise<string> {
		const record = this.records.get(agentId);
		if (!record) throw new Error(`Unknown agent: ${agentId}`);
		try {
			const data = await fs.promises.readFile(record.transcriptPath);
			return data.subarray(Math.max(0, data.length - maxBytes)).toString("utf8");
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	}

	private async flush(): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.registryPath), { recursive: true });
		const data: RegistryFile = { version: 1, parentSessionId: this.parentSessionId, records: this.list() };
		const temporary = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.promises.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(temporary, this.registryPath);
	}
}
