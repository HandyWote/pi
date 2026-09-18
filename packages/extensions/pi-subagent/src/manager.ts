import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Message } from "@handy_wote/pi-ai";
import { AgentRegistry, type ParentProcessIdentity } from "./registry.ts";
import { SUPERVISOR_FD_ENV, SUPERVISOR_STDIO_SLOT } from "./supervisor-watchdog.ts";
import {
	AGENT_PROTOCOL_VERSION,
	type AgentDefinition,
	type AgentLifecycleEvent,
	type AgentMode,
	type AgentOutput,
	type AgentRecord,
	type AgentStatus,
	emptyUsage,
	isTerminalStatus,
	type StartResult,
} from "./types.ts";
import { WorktreeService } from "./worktree.ts";

const MAX_CONCURRENCY = 8;
const MAX_ACTIVITIES = 20;
const SUBAGENT_COMMAND_ENV = "PI_SUBAGENT_COMMAND";
const SUBAGENT_PREFIX_ARGS_ENV = "PI_SUBAGENT_PREFIX_ARGS";
const WORKER_MODELS_FILE = "worker-models.json";
/** Residue from foreign sessions younger than this is assumed to belong to concurrent live sessions. */
const STALE_REGISTRY_MS = 7 * 24 * 3600 * 1000;
const execFileAsync = promisify(execFile);

interface PendingRun {
	agentId: string;
	prompt: string;
	resolve: (record: AgentRecord) => void;
	removeAbortListener: () => void;
}

interface ActiveRun {
	process?: ChildProcess;
	desiredStatus?: Extract<AgentStatus, "stopped" | "interrupted">;
	completion: Promise<AgentRecord>;
}

interface PiInvocation {
	command: string;
	prefixArgs: string[];
}

/**
 * A model reference in the /swarm worker pool snapshot. Entries are stored as
 * `{provider, id}` (plus an optional display label) so a spawned child pi can
 * resolve them with `--model <provider>/<id>` without re-consulting the
 * Runtime model list at spawn time.
 */
export interface WorkerModelRef {
	provider: string;
	id: string;
	label?: string;
}

/** Path of the persisted /swarm pool snapshot (`worker-models.json`). */
export function getWorkerModelsPath(rootDir: string): string {
	return path.join(rootDir, WORKER_MODELS_FILE);
}

/**
 * Read the /swarm pool snapshot in priority order. Entries that cannot be
 * resolved to a concrete model reference (missing provider/id) are skipped;
 * a missing, unreadable, or corrupt file yields an empty pool, so spawning
 * falls back to the main-session model.
 */
export async function readWorkerModels(rootDir: string): Promise<WorkerModelRef[]> {
	let content: string;
	try {
		content = await fs.promises.readFile(getWorkerModelsPath(rootDir), "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const refs: WorkerModelRef[] = [];
	for (const entry of parsed) {
		if (!isRecord(entry)) continue;
		const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!provider || !id) continue;
		const label = typeof entry.label === "string" ? entry.label.trim() : undefined;
		refs.push(label ? { provider, id, label } : { provider, id });
	}
	return refs;
}

/** Persist the /swarm worker pool snapshot. */
export async function writeWorkerModels(rootDir: string, refs: readonly WorkerModelRef[]): Promise<void> {
	await fs.promises.mkdir(rootDir, { recursive: true });
	await fs.promises.writeFile(getWorkerModelsPath(rootDir), `${JSON.stringify(refs, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export interface AgentManagerOptions {
	rootDir: string;
	parentSessionId: string;
	defaultCwd: string;
	concurrency?: number;
	invocation?: PiInvocation;
	killGraceMs?: number;
	processIdentityProbe?: (pid: number) => Promise<string | undefined>;
	sessionProcessProbe?: (sessionId: string) => Promise<number[]>;
	onLifecycle?: (event: AgentLifecycleEvent) => void;
	onTerminal?: (record: AgentRecord, event: AgentLifecycleEvent) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTextContent(message: Message): string {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getPiInvocation(): PiInvocation {
	const environmentInvocation = getEnvironmentInvocation();
	if (environmentInvocation) return environmentInvocation;
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, prefixArgs: [currentScript] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, prefixArgs: [] };
	return { command: "pi", prefixArgs: [] };
}

function getEnvironmentInvocation(): PiInvocation | undefined {
	const command = process.env[SUBAGENT_COMMAND_ENV]?.trim();
	const rawPrefixArgs = process.env[SUBAGENT_PREFIX_ARGS_ENV];
	if (!command && rawPrefixArgs === undefined) return undefined;
	if (!command) throw new Error(`${SUBAGENT_COMMAND_ENV} is required when ${SUBAGENT_PREFIX_ARGS_ENV} is set`);
	if (rawPrefixArgs === undefined) return { command, prefixArgs: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawPrefixArgs);
	} catch {
		throw new Error(`${SUBAGENT_PREFIX_ARGS_ENV} must be a JSON array of strings`);
	}
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
		throw new Error(`${SUBAGENT_PREFIX_ARGS_ENV} must be a JSON array of strings`);
	}
	return { command, prefixArgs: parsed };
}

/**
 * Map an orphaned entry name back to the agent ID it belongs to. Entries are
 * named after the agent: `sessions/<agentId>`, `prompts/<agentId>.md`,
 * `worktrees/<agentId>`, `transcripts/<agentId>.jsonl`.
 */
function entryAgentId(entryName: string): string {
	if (entryName.endsWith(".md") || entryName.endsWith(".jsonl"))
		return path.basename(entryName, path.extname(entryName));
	return entryName;
}

/**
 * An entry is stale when its mtime is past the window. Concurrent live
 * sessions stay fresh, so they and the residue they reference survive.
 */
async function isStalePath(entryPath: string, now: number): Promise<boolean> {
	try {
		const stats = await fs.promises.stat(entryPath);
		return now - stats.mtimeMs >= STALE_REGISTRY_MS;
	} catch {
		// Already gone or unreadable: nothing left to sweep.
		return false;
	}
}

function abortError(): Error {
	const error = new Error("Subagent start was aborted");
	error.name = "AbortError";
	return error;
}

export interface ChildSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: false;
	stdio: ["ignore", "pipe", "pipe", "pipe"];
}

/**
 * Build the spawn options for a child pi process. Pure aside from
 * `process.env`, so tests can assert the supervisor wiring without spawning a
 * real pi.
 *
 * The fourth stdio slot is a pipe whose write end the parent keeps open for the
 * child's lifetime without ever writing to or closing it explicitly (Node closes
 * it after 'close'). The child gets the fd number via
 * `PI_SUBAGENT_SUPERVISOR_FD` and watches the read end for EOF: when the parent
 * dies, the kernel closes its fds and the child sees EOF immediately (see
 * `supervisor-watchdog.ts`). This is fully event-driven - no timers, no
 * polling.
 */
export function buildChildSpawnOptions(
	env: NodeJS.ProcessEnv,
	runCwd: string,
	supervisorFdEnv: number,
): ChildSpawnOptions {
	return {
		cwd: runCwd,
		env: {
			...env,
			[SUPERVISOR_FD_ENV]: String(supervisorFdEnv),
		},
		shell: false,
		stdio: ["ignore", "pipe", "pipe", "pipe"],
	};
}

async function defaultProcessIdentityProbe(pid: number): Promise<string | undefined> {
	if (process.platform === "win32") {
		try {
			const { stdout } = await execFileAsync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
				],
				{ encoding: "utf8" },
			);
			const started = stdout.trim();
			return started ? `windows:${started}` : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/);
		const startTime = fields[19];
		if (startTime) return `proc:${startTime}`;
	} catch {}
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		const started = stdout.trim();
		return started ? `ps:${started}` : undefined;
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return isRecord(error) && error.code !== "ESRCH";
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function defaultSessionProcessProbe(sessionId: string): Promise<number[]> {
	const matches = new Set<number>();
	if (process.platform === "linux") {
		const entries = await fs.promises.readdir("/proc", { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
			const pid = Number(entry.name);
			if (pid === process.pid) continue;
			try {
				const args = (await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
				if (args.some((argument, index) => argument === "--session-id" && args[index + 1] === sessionId))
					matches.add(pid);
			} catch {}
		}
		return [...matches];
	}
	const escapedSessionId = escapeRegExp(sessionId);
	if (process.platform === "win32") {
		const script = `$pattern = '(?:^|\\s)--session-id\\s+"?${escapedSessionId}"?(?:\\s|$)'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object { $_.ProcessId }`;
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8",
		});
		for (const line of stdout.split(/\r?\n/)) {
			const pid = Number(line.trim());
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) matches.add(pid);
		}
		return [...matches];
	}
	const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
	const pattern = new RegExp(
		`(?:^|\\s)--session-id\\s+(?:"${escapedSessionId}"|'${escapedSessionId}'|${escapedSessionId})(?:\\s|$)`,
	);
	for (const line of stdout.split("\n")) {
		const parsed = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!parsed || !pattern.test(parsed[2] ?? "")) continue;
		const pid = Number(parsed[1]);
		if (pid !== process.pid) matches.add(pid);
	}
	return [...matches];
}

async function findChildSessionPath(sessionDir: string, sessionId: string): Promise<string | undefined> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const filePath = path.join(sessionDir, entry.name);
		try {
			const handle = await fs.promises.open(filePath, "r");
			try {
				const buffer = Buffer.alloc(4096);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
				const header: unknown = JSON.parse(line);
				if (isRecord(header) && header.id === sessionId) return filePath;
			} finally {
				await handle.close();
			}
		} catch {}
	}
	return undefined;
}

export class AgentManager {
	readonly registry: AgentRegistry;
	/** Directory holding registry state; also the location of the worker pool snapshot. */
	readonly rootDir: string;
	private readonly options: AgentManagerOptions;
	private readonly concurrency: number;
	private readonly invocation: PiInvocation;
	private readonly killGraceMs: number;
	private readonly processIdentityProbe: (pid: number) => Promise<string | undefined>;
	private readonly sessionProcessProbe: (sessionId: string) => Promise<number[]>;
	private readonly worktrees: WorktreeService;
	private readonly queue: PendingRun[] = [];
	private readonly active = new Map<string, ActiveRun>();
	private readonly completions = new Map<string, Promise<AgentRecord>>();
	private readonly listeners = new Set<(event: AgentLifecycleEvent) => void>();
	private shuttingDown = false;

	constructor(options: AgentManagerOptions) {
		this.options = options;
		this.rootDir = options.rootDir;
		this.concurrency = Math.max(1, Math.min(options.concurrency ?? 4, MAX_CONCURRENCY));
		this.invocation = options.invocation ?? getPiInvocation();
		this.killGraceMs = options.killGraceMs ?? 5000;
		this.processIdentityProbe = options.processIdentityProbe ?? defaultProcessIdentityProbe;
		this.sessionProcessProbe = options.sessionProcessProbe ?? defaultSessionProcessProbe;
		this.registry = new AgentRegistry(options.rootDir, options.parentSessionId);
		this.worktrees = new WorktreeService(options.rootDir);
	}

	async initialize(): Promise<void> {
		await this.registry.load();
		// Record this process as the registry's owner so foreign sessions can
		// fact-check our liveness instead of guessing from file mtimes. Uses the
		// real system probe (not the injectable one): reading our own start time
		// cannot fail or hang, and test probes must not block initialization.
		const parentToken = await defaultProcessIdentityProbe(process.pid);
		if (parentToken !== undefined) {
			await this.registry.setParentProcessIdentity({ pid: process.pid, processStartToken: parentToken });
		}
		const records = this.registry.list();
		// Interrupted records left by a graceful `shutdown()` (e.g. extension reload)
		// are kept for `/agents` history and resume; only live leftovers mean the
		// previous parent session crashed. Terminate any orphan children, then
		// drop all of that session's state instead of resuming it.
		if (records.some((record) => record.status === "queued" || record.status === "running")) {
			for (const record of records) {
				if (record.status !== "queued" && record.status !== "running") continue;
				if (record.status === "queued") await this.terminateRecoveredQueuedProcesses(record);
				else await this.terminateRecoveredProcess(record);
			}
			await this.clearState();
			return;
		}
		await this.sweepStaleState();
	}

	list(): AgentRecord[] {
		return this.registry.list();
	}

	get(agentId: string): AgentRecord | undefined {
		return this.registry.get(agentId);
	}

	getActiveCount(): number {
		return this.active.size;
	}

	subscribe(listener: (event: AgentLifecycleEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	republishActive(): void {
		for (const record of this.registry.list()) {
			if (record.status === "queued" || record.status === "running") this.publish(record);
		}
	}

	async start(
		definition: AgentDefinition,
		input: {
			task: string;
			mode: AgentMode;
			cwd?: string;
			isolation?: AgentRecord["isolation"];
			metadata?: Record<string, string>;
			signal?: AbortSignal;
		},
	): Promise<StartResult> {
		if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
		if (input.signal?.aborted) throw abortError();
		const agentId = `agent-${randomUUID()}`;
		const now = new Date().toISOString();
		const record: AgentRecord = {
			version: 2,
			agentId,
			runId: randomUUID(),
			parentSessionId: this.options.parentSessionId,
			definition,
			task: input.task,
			mode: input.mode,
			status: "queued",
			cwd: input.cwd ? path.resolve(this.options.defaultCwd, input.cwd) : path.resolve(this.options.defaultCwd),
			isolation: input.isolation ?? definition.isolation,
			metadata: { ...input.metadata },
			createdAt: now,
			updatedAt: now,
			childSessionId: agentId,
			childSessionDir: path.join(this.options.rootDir, "sessions", agentId),
			model: await this.resolveWorkerModel(definition),
			usage: emptyUsage(),
			toolCount: 0,
			lastOutput: "",
			activities: [],
			notified: false,
			lifecycleEventId: randomUUID(),
		};
		await this.registry.save(record);
		this.publish(record);
		const result = this.schedule(record, input.task, input.signal);
		if (input.signal?.aborted) {
			await result.completion;
			throw abortError();
		}
		return result;
	}

	async resume(agentId: string, prompt: string, mode?: AgentMode, signal?: AbortSignal): Promise<StartResult> {
		if (signal?.aborted) throw abortError();
		const current = this.registry.get(agentId);
		if (!current) throw new Error(`Unknown agent: ${agentId}`);
		if (!isTerminalStatus(current.status)) throw new Error(`Agent ${agentId} is ${current.status}, not resumable`);
		if (!current.childSessionPath)
			throw new Error(`Agent ${agentId} cannot resume because its durable child session is unavailable`);
		const childSessionPath = await findChildSessionPath(current.childSessionDir, current.childSessionId);
		if (childSessionPath !== current.childSessionPath)
			throw new Error(`Agent ${agentId} cannot resume because its durable child session is unavailable`);
		if (signal?.aborted) throw abortError();
		const now = new Date().toISOString();
		const record = await this.registry.update(agentId, (entry) => {
			if (!isTerminalStatus(entry.status)) throw new Error(`Agent ${agentId} is ${entry.status}, not resumable`);
			if (entry.childSessionPath !== childSessionPath)
				throw new Error(`Agent ${agentId} cannot resume because its durable child session changed`);
			return {
				...entry,
				runId: randomUUID(),
				mode: mode ?? entry.mode,
				status: "queued",
				updatedAt: now,
				endedAt: undefined,
				exitCode: undefined,
				error: undefined,
				cleanupError: undefined,
				notified: false,
				lifecycleEventId: randomUUID(),
			};
		});
		this.publish(record);
		const result = this.schedule(record, prompt, signal);
		if (signal?.aborted) {
			await result.completion;
			throw abortError();
		}
		return result;
	}

	async stop(agentId: string): Promise<AgentRecord> {
		const record = this.registry.get(agentId);
		if (!record) throw new Error(`Unknown agent: ${agentId}`);
		const active = this.active.get(agentId);
		if (record.status === "queued") {
			const index = this.queue.findIndex((item) => item.agentId === agentId);
			if (index < 0 && active) {
				active.desiredStatus = "stopped";
				if (active.process) this.terminate(active.process);
				return active.completion;
			}
			if (index < 0) return this.finishWithoutProcess(agentId, "interrupted", "Queued agent is unavailable");
			const [pending] = this.queue.splice(index, 1);
			const stopped = await this.finishWithoutProcess(agentId, "stopped", "Stopped before launch");
			pending?.removeAbortListener();
			pending?.resolve(stopped);
			return stopped;
		}
		if (record.status !== "running") throw new Error(`Agent ${agentId} is ${record.status}, not running`);
		if (!active) return this.finishWithoutProcess(agentId, "interrupted", "Agent process is unavailable");
		active.desiredStatus = "stopped";
		if (active.process) this.terminate(active.process);
		return active.completion;
	}

	async output(agentId: string, block: boolean, timeoutMs: number): Promise<AgentOutput> {
		let record = this.registry.get(agentId);
		if (!record) throw new Error(`Unknown agent: ${agentId}`);
		if (block && !isTerminalStatus(record.status)) {
			const completion = this.completions.get(agentId);
			if (completion) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					timer.unref();
					completion.then(() => {
						clearTimeout(timer);
						resolve();
					});
				});
				record = this.registry.get(agentId) ?? record;
			}
		}
		return {
			record,
			transcript: this.registry.readTranscript(agentId),
			ready: isTerminalStatus(record.status),
		};
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const queued = this.queue.splice(0);
		for (const pending of queued) {
			const interrupted = await this.finishWithoutProcess(pending.agentId, "interrupted", "Parent session stopped");
			pending.removeAbortListener();
			pending.resolve(interrupted);
		}
		const active = [...this.active.values()];
		for (const run of active) {
			run.desiredStatus = "interrupted";
			if (run.process) this.terminate(run.process);
		}
		await Promise.all(active.map((run) => run.completion));
	}

	/**
	 * Sweep foreign sessions whose state is past the staleness window. A
	 * registry is only swept when its owning parent process is verifiably not
	 * alive (or its identity cannot be checked, e.g. legacy registries without
	 * a recorded parent process), so concurrent live sessions are never touched
	 * no matter how long they have been idle. Unreferenced residue files with
	 * no surviving registry are reclaimed once their mtime ages out of the
	 * window, which also recovers legacy `transcripts/` directories.
	 */
	private async sweepStaleState(): Promise<void> {
		const now = Date.now();
		const retainedWorktrees = new Set<string>();
		await this.sweepStaleRegistries(now, retainedWorktrees);
		await this.sweepOrphanedEntries(now, retainedWorktrees);
	}

	/** Sweep foreign registries whose owning parent process is verifiably dead. */
	private async sweepStaleRegistries(now: number, retainedWorktrees: Set<string>): Promise<void> {
		let sweptRegistries = 0;
		for (const entry of await this.listDirectoryEntries("registries")) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const parentSessionId = path.basename(entry.name, ".json");
			if (parentSessionId === this.registry.parentSessionId) continue;
			const registryPath = path.join(this.rootDir, "registries", entry.name);
			if (!(await isStalePath(registryPath, now))) continue;
			const foreign = new AgentRegistry(this.rootDir, parentSessionId);
			let records: AgentRecord[] = [];
			let parentIdentity: ParentProcessIdentity | undefined;
			try {
				await foreign.load();
				records = foreign.list();
				parentIdentity = foreign.getParentProcessIdentity();
			} catch {
				// Corrupt or structurally invalid file: stale residue with nothing
				// killable; the caller still deletes the file.
			}
			// A recorded parent that is still running protects its session no
			// matter how idle it is; registries without a recorded identity
			// (legacy) fall back to the mtime-window judgment above.
			if (await this.recordedParentIsAlive(parentIdentity)) continue;
			for (const record of records) {
				if (record.status === "queued" || record.status === "running") {
					let terminated = false;
					try {
						terminated =
							record.status === "queued"
								? await this.terminateRecoveredQueuedProcesses(record)
								: await this.terminateRecoveredProcess(record);
					} catch {
						// Unverifiable process identity: leave the process alone and
						// keep reclaiming the record's files.
					}
					if (terminated)
						console.error(`[pi-subagent] terminated orphaned ${record.status} subagent ${record.agentId}`);
				}
				await this.clearRecordState(record, retainedWorktrees);
			}
			await fs.promises.rm(registryPath, { force: true });
			sweptRegistries++;
		}
		if (sweptRegistries > 0)
			console.error(
				`[pi-subagent] swept ${sweptRegistries} stale ${sweptRegistries === 1 ? "registry" : "registries"} from crashed sessions`,
			);
	}

	/**
	 * Whether a recorded parent-process identity still corresponds to a living
	 * pi process. Registries written by this extension version record their
	 * parent's pid plus process start token, so liveness is a fact check: a
	 * live parent (even an idle one) protects its session from the sweep.
	 * `undefined` (legacy registries without the recorded identity) yields
	 * `false`, falling back to the pre-existing mtime-only judgment.
	 */
	private async recordedParentIsAlive(identity: ParentProcessIdentity | undefined): Promise<boolean> {
		if (!identity) return false;
		if (identity.pid === process.pid) return true;
		const current = await this.processIdentityProbe(identity.pid);
		if (current === undefined) {
			// Unreadable probe: only treat the parent as dead when the pid is gone.
			return processIsAlive(identity.pid);
		}
		return current === identity.processStartToken;
	}

	/**
	 * Reclaim orphaned residue under rootDir that no surviving registry (this
	 * session plus fresh foreign ones) references and whose mtime is past the
	 * staleness window. Residue of just-swept registries is unreferenced by
	 * construction, so it is reclaimed here subject to the mtime gate.
	 */
	private async sweepOrphanedEntries(now: number, retainedWorktrees: Set<string>): Promise<void> {
		const referencedAgentIds = new Set<string>();
		for (const record of this.registry.list()) referencedAgentIds.add(record.agentId);
		for (const entry of await this.listDirectoryEntries("registries")) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const parsed: unknown = JSON.parse(
					await fs.promises.readFile(path.join(this.rootDir, "registries", entry.name), "utf8"),
				);
				if (!isRecord(parsed) || !Array.isArray(parsed.records)) continue;
				for (const value of parsed.records) {
					if (isRecord(value) && typeof value.agentId === "string") referencedAgentIds.add(value.agentId);
				}
			} catch {
				// Corrupt or unreadable registry: nothing referenceable. Stale ones
				// were already deleted above, so anything left here is fresh and its
				// residue is protected by the mtime gate below.
			}
		}
		let removedEntries = 0;
		let prunedWorktrees = false;
		for (const directory of ["sessions", "worktrees", "prompts", "transcripts"]) {
			for (const entry of await this.listDirectoryEntries(directory)) {
				if (referencedAgentIds.has(entryAgentId(entry.name))) continue;
				const entryPath = path.join(this.rootDir, directory, entry.name);
				if (!(await isStalePath(entryPath, now))) continue;
				// The entry is unreferenced by any registry, but a worktree may
				// still hold uncommitted user work even after the staleness window:
				// dirty worktrees are never destroyed, only reported. Clean ones
				// (and every other directory) are reclaimed.
				if (directory === "worktrees" && (await this.worktreeHasUserChanges(entryPath))) {
					if (!retainedWorktrees.has(entryPath)) {
						retainedWorktrees.add(entryPath);
						console.error(
							`[pi-subagent] retained unclaimed worktree with uncommitted changes: ${entryPath} (uncommitted changes are yours to keep or discard)`,
						);
					}
					continue;
				}
				await fs.promises.rm(entryPath, { recursive: true, force: true });
				removedEntries++;
				if (directory === "worktrees") prunedWorktrees = true;
			}
		}
		if (prunedWorktrees) await this.worktrees.pruneOrphaned(this.options.defaultCwd);
		for (const entry of await this.listDirectoryEntries("registries")) {
			if (!entry.name.endsWith(".tmp")) continue;
			const entryPath = path.join(this.rootDir, "registries", entry.name);
			if (!(await isStalePath(entryPath, now))) continue;
			await fs.promises.rm(entryPath, { force: true });
			removedEntries++;
		}
		if (removedEntries > 0)
			console.error(
				`[pi-subagent] swept ${removedEntries} orphaned state ${removedEntries === 1 ? "entry" : "entries"}`,
			);
	}

	/** List a subdirectory of rootDir; missing or unreadable directories yield nothing. */
	private async listDirectoryEntries(directory: string): Promise<fs.Dirent[]> {
		try {
			return await fs.promises.readdir(path.join(this.rootDir, directory), { withFileTypes: true });
		} catch {
			return [];
		}
	}

	/**
	 * Per-record equivalent of clearState for a swept foreign record: remove
	 * the child session directory, prompt file, worktree, and branch. The
	 * transcript is deliberately untouched here; the orphan sweep reclaims
	 * transcript files once no registry references them.
	 */
	private async clearRecordState(record: AgentRecord, retainedWorktrees: Set<string>): Promise<void> {
		await fs.promises.rm(record.childSessionDir, { recursive: true, force: true });
		await fs.promises.rm(path.join(this.rootDir, "prompts", `${record.agentId}.md`), { force: true });
		await this.cleanupWorktreeForRecord(record, retainedWorktrees);
		await this.deleteBranchBestEffort(record);
	}

	/**
	 * Whether a worktree directory still holds uncommitted user work. Runs
	 * `git status --porcelain` against the directory when it is a valid
	 * worktree of a readable repository; anything that cannot be checked (git
	 * missing, repository gone) counts as dirty, so the sweep errs on the side
	 * of keeping user content.
	 */
	private async worktreeHasUserChanges(worktreePath: string): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"], {
				encoding: "utf8",
			});
			return stdout.trim().length > 0;
		} catch {
			return true;
		}
	}

	/**
	 * Teardown-time worktree handling for one agent. The worktree directory is
	 * created by the agent, but its contents belong to the user and git, so a
	 * dirty worktree is never destroyed here: the non-forced removal removes
	 * clean checkouts and retains dirty ones with a stderr notice pointing at
	 * the path. A retained worktree also keeps its branch checked out, which
	 * makes branch deletion fail benignly in `deleteBranchBestEffort`, so
	 * committed work stays recoverable too. The startup sweep reclaims
	 * leftover directories once they age out of the staleness window.
	 */
	private async cleanupWorktreeForRecord(record: AgentRecord, retainedWorktrees?: Set<string>): Promise<void> {
		if (!record.worktreePath) return;
		const removeError = await this.worktrees.cleanup(record.worktreePath, record.cwd);
		if (removeError === undefined) return;
		retainedWorktrees?.add(record.worktreePath);
		console.error(
			`[pi-subagent] retained worktree for agent ${record.agentId} with uncommitted changes: ${record.worktreePath} ` +
				`(uncommitted changes are yours to keep or discard)`,
		);
	}

	/** Terminate children, then delete this session's persisted state. */
	async destroy(): Promise<void> {
		await this.shutdown();
		await this.clearState();
	}

	/**
	 * Delete every file and branch this session owns, scoped to this manager's
	 * parent session. The shared `rootDir` is never removed because other pi
	 * sessions store their state alongside this one.
	 */
	private async clearState(): Promise<void> {
		const records = this.registry.list();
		for (const record of records) {
			// Transcripts are process-local memory owned by the buffer; drop them here.
			this.registry.transcripts.clear(record.agentId);
			await fs.promises.rm(record.childSessionDir, { recursive: true, force: true });
			await fs.promises.rm(path.join(this.rootDir, "prompts", `${record.agentId}.md`), { force: true });
			await this.cleanupWorktreeForRecord(record);
			await this.deleteBranchBestEffort(record);
		}
		await fs.promises.rm(this.registry.registryPath, { force: true });
		// The worker-pool snapshot is shared configuration, not session state;
		// it survives shutdown so the pool does not reset on every exit.
		// Remove now-empty session directories. rmdir only succeeds when a directory
		// is empty, so parallel sessions sharing the root keep their own state.
		for (const directory of ["sessions", "prompts", "registries", "worktrees", ""]) {
			try {
				await fs.promises.rmdir(path.join(this.rootDir, directory));
			} catch {
				// Not empty or already gone; leave it for the other sessions.
			}
		}
		// Reload so the in-memory records match the now-empty registry; the file
		// is gone, so load() resets to an empty map and the manager stays usable.
		await this.registry.load();
	}

	private async deleteBranchBestEffort(record: AgentRecord): Promise<void> {
		const branch = `pi-subagent/${record.agentId}`;
		try {
			const { stdout } = await execFileAsync("git", ["-C", record.cwd, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
			});
			const repository = stdout.trim();
			if (!repository) return;
			await execFileAsync("git", ["-C", repository, "branch", "-D", branch], { encoding: "utf8" });
		} catch {
			// Best effort: the branch may still be checked out in a surviving
			// worktree or the repository may be gone. Session state is already deleted.
		}
	}

	/**
	 * Resolve the model for a worker at spawn time (single source):
	 * 1. explicit `model` in the agent definition (user-declared intent, used as-is),
	 * 2. the /swarm pool, first resolvable entry in priority order,
	 * 3. undefined — no `--model`, the child inherits the main-session model.
	 * Pool entries carry concrete `{provider, id}` references snapshotted by
	 * /swarm, so they are passed to the child directly; structurally invalid
	 * entries are skipped by readWorkerModels.
	 */
	private async resolveWorkerModel(definition: AgentDefinition): Promise<string | undefined> {
		if (definition.model) return definition.model;
		const pool = await readWorkerModels(this.options.rootDir);
		const first = pool[0];
		if (!first) return undefined;
		return `${first.provider}/${first.id}`;
	}

	private drain(): void {
		while (!this.shuttingDown && this.active.size < this.concurrency && this.queue.length > 0) {
			const pending = this.queue.shift();
			if (!pending) return;
			const completion = this.run(pending).catch(async (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				return this.finishWithoutProcess(pending.agentId, "failed", message);
			});
			this.active.set(pending.agentId, { completion });
			completion.then((record) => {
				pending.removeAbortListener();
				pending.resolve(record);
			});
		}
	}

	private async run(pending: PendingRun): Promise<AgentRecord> {
		let record = this.registry.get(pending.agentId);
		if (!record) throw new Error(`Unknown agent: ${pending.agentId}`);
		let runCwd = record.cwd;
		if (record.isolation === "worktree") {
			const worktree = await this.worktrees.create(record.agentId, record.cwd);
			runCwd = worktree.cwd;
			record = await this.registry.update(record.agentId, (entry) => ({
				...entry,
				worktreePath: worktree.path,
				worktreeBranch: worktree.branch,
			}));
		}
		const preparingRun = this.active.get(record.agentId);
		if (preparingRun?.desiredStatus) {
			return this.finishWithoutProcess(record.agentId, preparingRun.desiredStatus, "Stopped before launch");
		}
		await fs.promises.mkdir(record.childSessionDir, { recursive: true });
		const afterSessionDirectory = this.active.get(record.agentId)?.desiredStatus;
		if (afterSessionDirectory)
			return this.finishWithoutProcess(record.agentId, afterSessionDirectory, "Stopped before launch");
		const promptDir = path.join(this.options.rootDir, "prompts");
		await fs.promises.mkdir(promptDir, { recursive: true });
		const afterPromptDirectory = this.active.get(record.agentId)?.desiredStatus;
		if (afterPromptDirectory)
			return this.finishWithoutProcess(record.agentId, afterPromptDirectory, "Stopped before launch");
		const promptPath = path.join(promptDir, `${record.agentId}.md`);
		await fs.promises.writeFile(promptPath, record.definition.systemPrompt, { encoding: "utf8", mode: 0o600 });
		const afterPromptWrite = this.active.get(record.agentId)?.desiredStatus;
		if (afterPromptWrite) return this.finishWithoutProcess(record.agentId, afterPromptWrite, "Stopped before launch");

		const args = [
			...this.invocation.prefixArgs,
			"--mode",
			"json",
			"-p",
			"--session-id",
			record.childSessionId,
			"--session-dir",
			record.childSessionDir,
		];
		if (record.model) args.push("--model", record.model);
		if (record.definition.tools?.length) args.push("--tools", record.definition.tools.join(","));
		if (record.definition.systemPrompt) args.push("--append-system-prompt", promptPath);
		args.push(`Task: ${pending.prompt}`);
		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			PI_AGENT_CONTEXT: JSON.stringify({
				version: AGENT_PROTOCOL_VERSION,
				agentId: record.agentId,
				runId: record.runId,
				parentSessionId: record.parentSessionId,
				metadata: record.metadata,
			}),
		};
		const child = spawn(
			this.invocation.command,
			args,
			buildChildSpawnOptions(childEnv, runCwd, SUPERVISOR_STDIO_SLOT),
		);
		const agentId = record.agentId;
		const active = this.active.get(agentId);
		if (active) active.process = child;
		const childStdout = child.stdout;
		const childStderr = child.stderr;
		if (!childStdout || !childStderr) throw new Error("Child stdio pipes are unavailable");
		const supervisorWriteEnd = child.stdio[SUPERVISOR_STDIO_SLOT];
		if (!supervisorWriteEnd) throw new Error("Supervisor pipe write end is unavailable");
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let processing = Promise.resolve();
		let resolveSettled = () => {};
		const settledPromise = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		childStdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processing = processing.then(async () => {
					if (await this.processLine(agentId, line)) resolveSettled();
				});
			}
		});
		const stdoutEnded = new Promise<void>((resolve) => childStdout.once("end", resolve));
		childStderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderrBuffer += text;
			processing = processing.then(() => {
				this.registry.appendTranscript(agentId, { type: "stderr", text, timestamp: Date.now() });
			});
		});
		const stderrEnded = new Promise<void>((resolve) => childStderr.once("end", resolve));
		const exitPromise = new Promise<
			{ ok: true; code: number | null; signal: NodeJS.Signals | null } | { ok: false; error: Error }
		>((resolve) => {
			// Destroy the supervisor pipe's write end once the child is gone; the
			// read end died with it, so holding the fd would leak it until this
			// process exits. Normal terminate/stop/shutdown paths kill the child
			// first and flow through the same 'close'.
			child.once("close", () => supervisorWriteEnd.destroy());
			child.once("close", (code, signal) => resolve({ ok: true, code, signal }));
			child.once("error", (error) => resolve({ ok: false, error }));
		});
		const started = new Date().toISOString();
		const pid = child.pid;
		const startToken = pid === undefined ? undefined : await this.processIdentityProbe(pid);
		if (pid !== undefined && startToken === undefined && processIsAlive(pid)) {
			this.terminate(child);
			await exitPromise;
			await Promise.all([stdoutEnded, stderrEnded]);
			await processing;
			throw new Error(`Cannot establish process identity for agent ${record.agentId}`);
		}
		record = await this.registry.update(record.agentId, (entry) => ({
			...entry,
			status: "running",
			startedAt: started,
			updatedAt: started,
			pid: startToken === undefined ? undefined : pid,
			processStartToken: startToken,
			lifecycleEventId: randomUUID(),
		}));
		this.publish(record);

		const firstOutcome = await Promise.race([
			exitPromise.then((exit) => ({ type: "exit" as const, exit })),
			settledPromise.then(() => ({ type: "settled" as const })),
		]);
		const settledBeforeExit = firstOutcome.type === "settled";
		if (settledBeforeExit) {
			this.terminate(child);
		}
		const exit = firstOutcome.type === "exit" ? firstOutcome.exit : await exitPromise;
		if (!exit.ok) throw exit.error;
		await Promise.all([stdoutEnded, stderrEnded]);
		if (stdoutBuffer.trim()) {
			processing = processing.then(async () => {
				await this.processLine(record.agentId, stdoutBuffer);
			});
		}
		await processing;
		const currentRun = this.active.get(record.agentId);
		const desiredStatus = currentRun?.desiredStatus;
		const status: AgentStatus = desiredStatus ?? (exit.code === 0 || settledBeforeExit ? "completed" : "failed");
		const message =
			desiredStatus === "stopped"
				? "Stopped by user"
				: desiredStatus === "interrupted"
					? "Parent session stopped"
					: exit.code === 0 || settledBeforeExit
						? undefined
						: `Agent exited with code ${exit.code ?? "null"}${exit.signal ? ` (${exit.signal})` : ""}${stderrBuffer.trim() ? `\n${stderrBuffer.trim()}` : ""}`;
		return this.finish(record.agentId, status, message, exit.code ?? undefined);
	}

	private async processLine(agentId: string, line: string): Promise<boolean> {
		if (!line.trim()) return false;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			event = { type: "stdout", text: line, timestamp: Date.now() };
		}
		this.registry.appendTranscript(agentId, event);
		if (!isRecord(event)) return false;
		if (event.type === "agent_settled") return true;
		if (event.type !== "message_end" && event.type !== "tool_result_end") return false;
		if (!isRecord(event.message) || !Array.isArray(event.message.content)) return false;
		if (event.message.role !== "assistant" && event.message.role !== "toolResult") return false;
		if (event.message.role === "assistant" && (!isRecord(event.message.usage) || !isRecord(event.message.usage.cost)))
			return false;
		const message = event.message as unknown as Message;
		const text = getTextContent(message);
		const updated = await this.registry.update(agentId, (entry) => {
			const activities = [...entry.activities];
			let toolCount = entry.toolCount;
			let usage = entry.usage;
			let model = entry.model;
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type === "toolCall") {
						toolCount++;
						activities.push({ type: "tool", text: part.name, timestamp: message.timestamp });
					}
				}
				usage = {
					input: usage.input + message.usage.input,
					output: usage.output + message.usage.output,
					cacheRead: usage.cacheRead + message.usage.cacheRead,
					cacheWrite: usage.cacheWrite + message.usage.cacheWrite,
					cost: usage.cost + message.usage.cost.total,
					contextTokens: message.usage.totalTokens,
					turns: usage.turns + 1,
				};
				model = message.model;
			}
			if (text) activities.push({ type: "text", text, timestamp: Date.now() });
			return {
				...entry,
				activities: activities.slice(-MAX_ACTIVITIES),
				toolCount,
				usage,
				model,
				lastOutput: text || entry.lastOutput,
				updatedAt: new Date().toISOString(),
			};
		});
		this.notifySubscribers(updated);
		return false;
	}

	private async finishWithoutProcess(agentId: string, status: AgentStatus, error?: string): Promise<AgentRecord> {
		return this.finish(agentId, status, error);
	}

	private async finish(agentId: string, status: AgentStatus, error?: string, exitCode?: number): Promise<AgentRecord> {
		const endedAt = new Date().toISOString();
		const current = this.registry.get(agentId);
		if (!current) throw new Error(`Unknown agent: ${agentId}`);
		const childSessionPath = await findChildSessionPath(current.childSessionDir, current.childSessionId);
		const cleanupError = current.worktreePath
			? await this.worktrees.cleanup(current.worktreePath, current.cwd)
			: undefined;
		let record = await this.registry.update(agentId, (entry) => ({
			...entry,
			status,
			endedAt,
			updatedAt: endedAt,
			childSessionPath,
			worktreePath: cleanupError ? entry.worktreePath : undefined,
			cleanupError,
			pid: undefined,
			processStartToken: undefined,
			exitCode,
			error: error ?? entry.error,
			lifecycleEventId: randomUUID(),
		}));
		const event = this.publish(record);
		if (record.mode === "background" && !record.notified) {
			record = await this.registry.update(agentId, (entry) => ({ ...entry, notified: true }));
			try {
				this.options.onTerminal?.(record, event);
			} catch {
				// Terminal state is already durable; notification failures do not change it.
			}
		}
		this.active.delete(agentId);
		this.completions.delete(agentId);
		this.drain();
		return record;
	}

	private publish(record: AgentRecord): AgentLifecycleEvent {
		const event: AgentLifecycleEvent = {
			version: AGENT_PROTOCOL_VERSION,
			eventId: record.lifecycleEventId,
			runId: record.runId,
			agentId: record.agentId,
			parentSessionId: record.parentSessionId,
			status: record.status,
			timestamp: new Date().toISOString(),
			metadata: { ...record.metadata },
		};
		try {
			this.options.onLifecycle?.(event);
		} catch {
			// Live events are advisory; durable registry state remains authoritative.
		}
		this.notifySubscribers(record, event);
		return event;
	}

	private notifySubscribers(record: AgentRecord, event?: AgentLifecycleEvent): void {
		const notification = event ?? {
			version: AGENT_PROTOCOL_VERSION,
			eventId: record.lifecycleEventId,
			runId: record.runId,
			agentId: record.agentId,
			parentSessionId: record.parentSessionId,
			status: record.status,
			timestamp: new Date().toISOString(),
			metadata: { ...record.metadata },
		};
		for (const listener of this.listeners) {
			try {
				listener(notification);
			} catch {}
		}
	}

	private schedule(record: AgentRecord, prompt: string, signal?: AbortSignal): StartResult {
		let removeAbortListener = () => {};
		let completionResolve: (record: AgentRecord) => void = () => {};
		const completion = new Promise<AgentRecord>((resolve) => {
			completionResolve = resolve;
		});
		const abort = () => {
			void this.stop(record.agentId).catch(() => {});
		};
		if (signal) {
			signal.addEventListener("abort", abort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", abort);
		}
		this.queue.push({ agentId: record.agentId, prompt, resolve: completionResolve, removeAbortListener });
		this.completions.set(record.agentId, completion);
		if (signal?.aborted) abort();
		this.drain();
		return { record, completion, detachAbort: removeAbortListener };
	}

	private async terminateRecoveredProcess(record: AgentRecord): Promise<boolean> {
		if (record.pid === undefined || record.processStartToken === undefined) return false;
		const identity = await this.processIdentityProbe(record.pid);
		if (identity === undefined) {
			if (processIsAlive(record.pid))
				throw new Error(`Cannot verify recovered agent process ${record.pid}; refusing unsafe recovery`);
			return false;
		}
		if (identity !== record.processStartToken) return false;
		try {
			process.kill(record.pid, "SIGTERM");
		} catch (error: unknown) {
			if (isRecord(error) && error.code === "ESRCH") return false;
			throw error;
		}
		if (await this.waitForRecoveredExit(record.pid, record.processStartToken, this.killGraceMs)) return true;
		try {
			process.kill(record.pid, "SIGKILL");
		} catch (error: unknown) {
			if (isRecord(error) && error.code === "ESRCH") return false;
			throw error;
		}
		if (!(await this.waitForRecoveredExit(record.pid, record.processStartToken, this.killGraceMs))) {
			throw new Error(`Unable to terminate recovered agent process ${record.pid}`);
		}
		return true;
	}

	private async terminateRecoveredQueuedProcesses(record: AgentRecord): Promise<boolean> {
		let terminated = false;
		for (const pid of await this.sessionProcessProbe(record.childSessionId)) {
			const identity = await this.processIdentityProbe(pid);
			if (!(await this.sessionProcessMatches(record.childSessionId, pid))) continue;
			try {
				process.kill(pid, "SIGTERM");
			} catch (error: unknown) {
				if (isRecord(error) && error.code === "ESRCH") continue;
				throw error;
			}
			if (await this.waitForRecoveredSessionExit(pid, record.childSessionId, identity, this.killGraceMs)) {
				terminated = true;
				continue;
			}
			if (!(await this.sessionProcessMatches(record.childSessionId, pid))) {
				terminated = true;
				continue;
			}
			if (identity !== undefined) {
				const currentIdentity = await this.processIdentityProbe(pid);
				if (currentIdentity !== undefined && currentIdentity !== identity) continue;
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch (error: unknown) {
				if (isRecord(error) && error.code === "ESRCH") continue;
				throw error;
			}
			if (!(await this.waitForRecoveredSessionExit(pid, record.childSessionId, identity, this.killGraceMs))) {
				throw new Error(`Unable to terminate recovered queued agent process ${pid}`);
			}
			terminated = true;
		}
		return terminated;
	}

	private async sessionProcessMatches(sessionId: string, pid: number): Promise<boolean> {
		return (await this.sessionProcessProbe(sessionId)).includes(pid);
	}

	private async waitForRecoveredSessionExit(
		pid: number,
		sessionId: string,
		identity: string | undefined,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		do {
			if (!(await this.sessionProcessMatches(sessionId, pid))) return true;
			if (identity !== undefined) {
				const currentIdentity = await this.processIdentityProbe(pid);
				if (currentIdentity !== undefined && currentIdentity !== identity) return true;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		} while (Date.now() < deadline);
		return false;
	}

	private async waitForRecoveredExit(pid: number, token: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		do {
			const current = await this.processIdentityProbe(pid);
			if (current === undefined) {
				if (!processIsAlive(pid)) return true;
			} else if (current !== token) return true;
			await new Promise((resolve) => setTimeout(resolve, 10));
		} while (Date.now() < deadline);
		return false;
	}

	private terminate(child: ChildProcess): void {
		child.kill("SIGTERM");
		const timer = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, this.killGraceMs);
		child.once("close", () => clearTimeout(timer));
	}
}
