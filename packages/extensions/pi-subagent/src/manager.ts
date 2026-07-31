import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Message } from "@handy_wote/pi-ai";
import { AgentRegistry } from "./registry.ts";
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

function abortError(): Error {
	const error = new Error("Subagent start was aborted");
	error.name = "AbortError";
	return error;
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
		for (const record of this.registry.list()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			if (record.status === "queued") await this.terminateRecoveredQueuedProcesses(record);
			else await this.terminateRecoveredProcess(record);
			await this.finishWithoutProcess(
				record.agentId,
				"interrupted",
				"Parent session stopped while agent was active",
			);
		}
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
			version: 1,
			agentId,
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
			transcriptPath: path.join(this.options.rootDir, "transcripts", `${agentId}.jsonl`),
			model: definition.model,
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
			transcript: await this.registry.readTranscript(agentId),
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
		if (record.definition.model) args.push("--model", record.definition.model);
		if (record.definition.tools?.length) args.push("--tools", record.definition.tools.join(","));
		if (record.definition.systemPrompt) args.push("--append-system-prompt", promptPath);
		args.push(`Task: ${pending.prompt}`);
		const child = spawn(this.invocation.command, args, {
			cwd: runCwd,
			env: {
				...process.env,
				PI_AGENT_CONTEXT: JSON.stringify({
					version: AGENT_PROTOCOL_VERSION,
					agentId: record.agentId,
					parentSessionId: record.parentSessionId,
					metadata: record.metadata,
				}),
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const agentId = record.agentId;
		const active = this.active.get(agentId);
		if (active) active.process = child;
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let processing = Promise.resolve();
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processing = processing.then(() => this.processLine(agentId, line));
		});
		const stdoutEnded = new Promise<void>((resolve) => child.stdout.once("end", resolve));
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderrBuffer += text;
			processing = processing.then(async () => {
				await this.registry.appendTranscript(agentId, { type: "stderr", text, timestamp: Date.now() });
			});
		});
		const stderrEnded = new Promise<void>((resolve) => child.stderr.once("end", resolve));
		const exitPromise = new Promise<
			{ ok: true; code: number | null; signal: NodeJS.Signals | null } | { ok: false; error: Error }
		>((resolve) => {
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

		const exit = await exitPromise;
		if (!exit.ok) throw exit.error;
		await Promise.all([stdoutEnded, stderrEnded]);
		if (stdoutBuffer.trim()) processing = processing.then(() => this.processLine(record.agentId, stdoutBuffer));
		await processing;
		const currentRun = this.active.get(record.agentId);
		const desiredStatus = currentRun?.desiredStatus;
		const status: AgentStatus = desiredStatus ?? (exit.code === 0 ? "completed" : "failed");
		const message =
			desiredStatus === "stopped"
				? "Stopped by user"
				: desiredStatus === "interrupted"
					? "Parent session stopped"
					: exit.code === 0
						? undefined
						: `Agent exited with code ${exit.code ?? "null"}${exit.signal ? ` (${exit.signal})` : ""}${stderrBuffer.trim() ? `\n${stderrBuffer.trim()}` : ""}`;
		return this.finish(record.agentId, status, message, exit.code ?? undefined);
	}

	private async processLine(agentId: string, line: string): Promise<void> {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			event = { type: "stdout", text: line, timestamp: Date.now() };
		}
		await this.registry.appendTranscript(agentId, event);
		if (!isRecord(event)) return;
		if (event.type !== "message_end" && event.type !== "tool_result_end") return;
		if (!isRecord(event.message) || !Array.isArray(event.message.content)) return;
		if (event.message.role !== "assistant" && event.message.role !== "toolResult") return;
		if (event.message.role === "assistant" && (!isRecord(event.message.usage) || !isRecord(event.message.usage.cost)))
			return;
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

	private async terminateRecoveredProcess(record: AgentRecord): Promise<void> {
		if (record.pid === undefined || record.processStartToken === undefined) return;
		const identity = await this.processIdentityProbe(record.pid);
		if (identity === undefined) {
			if (processIsAlive(record.pid))
				throw new Error(`Cannot verify recovered agent process ${record.pid}; refusing unsafe recovery`);
			return;
		}
		if (identity !== record.processStartToken) return;
		try {
			process.kill(record.pid, "SIGTERM");
		} catch (error: unknown) {
			if (isRecord(error) && error.code === "ESRCH") return;
			throw error;
		}
		if (await this.waitForRecoveredExit(record.pid, record.processStartToken, this.killGraceMs)) return;
		try {
			process.kill(record.pid, "SIGKILL");
		} catch (error: unknown) {
			if (isRecord(error) && error.code === "ESRCH") return;
			throw error;
		}
		if (!(await this.waitForRecoveredExit(record.pid, record.processStartToken, this.killGraceMs))) {
			throw new Error(`Unable to terminate recovered agent process ${record.pid}`);
		}
	}

	private async terminateRecoveredQueuedProcesses(record: AgentRecord): Promise<void> {
		for (const pid of await this.sessionProcessProbe(record.childSessionId)) {
			const identity = await this.processIdentityProbe(pid);
			if (!(await this.sessionProcessMatches(record.childSessionId, pid))) continue;
			try {
				process.kill(pid, "SIGTERM");
			} catch (error: unknown) {
				if (isRecord(error) && error.code === "ESRCH") continue;
				throw error;
			}
			if (await this.waitForRecoveredSessionExit(pid, record.childSessionId, identity, this.killGraceMs)) continue;
			if (!(await this.sessionProcessMatches(record.childSessionId, pid))) continue;
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
		}
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
		timer.unref();
	}
}
