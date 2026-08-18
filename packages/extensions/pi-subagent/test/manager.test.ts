import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, getWorkerModelsPath, writeWorkerModels } from "../src/manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import { type AgentDefinition, type AgentLifecycleEvent, type AgentRecord, emptyUsage } from "../src/types.ts";
import { WorktreeService } from "../src/worktree.ts";

const fixturePath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
const crashParentPath = fileURLToPath(new URL("fixtures/crash-parent.ts", import.meta.url));
const tempRoots: string[] = [];
const definition: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	tools: ["read"],
	model: "faux-model",
	systemPrompt: "Complete the delegated task.",
	source: "user",
	filePath: "/tmp/worker.md",
	isolation: "none",
};

function temporaryDirectory(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-manager-"));
	tempRoots.push(root);
	return root;
}

function createManager(
	root: string,
	overrides: Partial<ConstructorParameters<typeof AgentManager>[0]> = {},
): AgentManager {
	return new AgentManager({
		rootDir: path.join(root, "state"),
		parentSessionId: "parent-1",
		defaultCwd: root,
		invocation: { command: process.execPath, prefixArgs: [fixturePath] },
		killGraceMs: 40,
		...overrides,
	});
}

async function waitForStatus(manager: AgentManager, agentId: string, status: AgentRecord["status"]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (manager.get(agentId)?.status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Agent ${agentId} did not reach ${status}`);
}

async function waitForOutput(manager: AgentManager, agentId: string): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (manager.get(agentId)?.lastOutput) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Agent ${agentId} did not produce output`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return error instanceof Error && "code" in error && error.code !== "ESRCH";
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager", () => {
	it("runs a foreground agent with stable lifecycle IDs and opaque child context", async () => {
		const root = temporaryDirectory();
		const events: AgentLifecycleEvent[] = [];
		const manager = createManager(root, { onLifecycle: (event) => events.push(event) });
		await manager.initialize();

		const started = await manager.start(definition, {
			task: "inspect",
			mode: "foreground",
			metadata: { "external/correlation": "value" },
		});
		const completed = await started.completion;

		expect(started.record.status).toBe("queued");
		expect(completed.status).toBe("completed");
		expect(completed.agentId).toBe(started.record.agentId);
		expect(completed.toolCount).toBe(1);
		expect(completed.usage.turns).toBe(2);
		expect(await manager.registry.readTranscript(completed.agentId)).toContain("external/correlation");
		expect(events.map((event) => event.status)).toEqual(["queued", "running", "completed"]);
		expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
		expect(new Set(events.map((event) => event.runId))).toEqual(new Set([started.record.runId]));
		expect(events.every((event) => event.metadata["external/correlation"] === "value")).toBe(true);
	});

	it("publishes live activity updates before terminal completion", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const updates: AgentRecord[] = [];
		manager.subscribe((event) => {
			const record = manager.get(event.agentId);
			if (record) updates.push(record);
		});

		const started = await manager.start(definition, { task: "delay:80", mode: "foreground" });
		await started.completion;

		expect(updates.some((record) => record.status === "running" && record.toolCount > 0)).toBe(true);
		expect(updates.some((record) => record.status === "running" && record.lastOutput.includes("started"))).toBe(true);
	});

	it("does not persist or launch an already-aborted start", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const controller = new AbortController();
		controller.abort();

		await expect(
			manager.start(definition, { task: "must not run", mode: "foreground", signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(manager.list()).toEqual([]);
	});

	it("resolves relative invocation cwd from the parent session cwd", async () => {
		const root = temporaryDirectory();
		const nested = path.join(root, "packages", "worker");
		fs.mkdirSync(nested, { recursive: true });
		const manager = createManager(root);
		await manager.initialize();

		const started = await manager.start(definition, {
			task: "relative cwd",
			mode: "foreground",
			cwd: "packages/worker",
		});
		const completed = await started.completion;

		expect(completed.cwd).toBe(nested);
		// The child process reports its real cwd (macOS resolves the /var symlink
		// in the temporary directory), so normalize the expectation the same way.
		expect(await manager.registry.readTranscript(completed.agentId)).toContain(`cwd:${fs.realpathSync(nested)}`);
	});

	it("uses an environment launcher override for local source execution", async () => {
		const root = temporaryDirectory();
		vi.stubEnv("PI_SUBAGENT_COMMAND", process.execPath);
		vi.stubEnv("PI_SUBAGENT_PREFIX_ARGS", JSON.stringify([fixturePath]));
		const manager = new AgentManager({
			rootDir: path.join(root, "state"),
			parentSessionId: "parent-1",
			defaultCwd: root,
			killGraceMs: 40,
		});
		await manager.initialize();

		const started = await manager.start(definition, { task: "source-launcher", mode: "foreground" });
		const completed = await started.completion;

		expect(completed.status).toBe("completed");
		expect(completed.lastOutput).toContain("finished Task: source-launcher");
	});

	it("stops a running agent when its start signal aborts", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const controller = new AbortController();
		const started = await manager.start(definition, {
			task: "ignore-term delay:10000",
			mode: "foreground",
			signal: controller.signal,
		});
		await waitForOutput(manager, started.record.agentId);

		controller.abort();
		const stopped = await started.completion;

		expect(stopped.status).toBe("stopped");
		expect(stopped.lastOutput).toContain("started");
	});

	it("limits parallel work, provides blocking output, and notifies background completion once", async () => {
		const root = temporaryDirectory();
		let running = 0;
		let maximumRunning = 0;
		const notifications: string[] = [];
		const manager = createManager(root, {
			concurrency: 2,
			onLifecycle: (event) => {
				if (event.status === "running") {
					running++;
					maximumRunning = Math.max(maximumRunning, running);
				}
				if (["completed", "failed", "stopped", "interrupted"].includes(event.status)) running--;
			},
			onTerminal: (record) => notifications.push(record.agentId),
		});
		await manager.initialize();
		const starts = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				manager.start(definition, { task: `delay:${60 + index}`, mode: "background" }),
			),
		);
		const early = await manager.output(starts[0].record.agentId, false, 0);
		expect(early.ready).toBe(false);
		const waited = await manager.output(starts[0].record.agentId, true, 1000);
		expect(waited.ready).toBe(true);
		await Promise.all(starts.map((start) => start.completion));

		expect(maximumRunning).toBe(2);
		expect(notifications).toHaveLength(5);
		expect(new Set(notifications).size).toBe(5);
	});

	it("stops stubborn agents with forced termination and keeps partial output", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const started = await manager.start(definition, {
			task: "ignore-term delay:10000",
			mode: "background",
		});
		await waitForStatus(manager, started.record.agentId, "running");
		await waitForOutput(manager, started.record.agentId);

		const stopped = await manager.stop(started.record.agentId);

		expect(stopped.status).toBe("stopped");
		expect(stopped.lastOutput).toContain("started");
		await expect(manager.stop(stopped.agentId)).rejects.toThrow("not running");
	});

	it("does not retry failures and explicitly resumes the same child session", async () => {
		const root = temporaryDirectory();
		const events: AgentLifecycleEvent[] = [];
		const manager = createManager(root, { onLifecycle: (event) => events.push(event) });
		await manager.initialize();
		const started = await manager.start(definition, { task: "fail", mode: "background" });
		const failed = await started.completion;
		const firstRunId = failed.runId;
		expect(failed.status).toBe("failed");
		expect(events.filter((event) => event.status === "running")).toHaveLength(1);

		const resumed = await manager.resume(failed.agentId, "resumed", "foreground");
		const completed = await resumed.completion;

		expect(completed.agentId).toBe(failed.agentId);
		expect(completed.runId).not.toBe(firstRunId);
		expect(completed.childSessionId).toBe(failed.childSessionId);
		expect(completed.status).toBe("completed");
		expect(completed.usage.turns).toBe(3);
		expect(completed.lastOutput).toContain("finished Task: resumed");
		expect(await manager.registry.readTranscript(completed.agentId)).toContain("prior-context:true");
		expect(fs.readFileSync(completed.childSessionPath!, "utf8")).toContain("Task: resumed");
		expect(events.filter((event) => event.status === "running")).toHaveLength(2);
		expect(new Set(events.map((event) => event.runId))).toEqual(new Set([firstRunId, completed.runId]));
	});

	it("refuses resume when the durable child session is missing", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const started = await manager.start(definition, { task: "initial", mode: "foreground" });
		const completed = await started.completion;
		if (!completed.childSessionPath) throw new Error("Expected a child session path");
		fs.rmSync(completed.childSessionPath);

		await expect(manager.resume(completed.agentId, "must not restart")).rejects.toThrow(
			"durable child session is unavailable",
		);
		expect(manager.get(completed.agentId)?.status).toBe("completed");
	});

	it("records spawn errors as failed instead of completed", async () => {
		const root = temporaryDirectory();
		const events: AgentLifecycleEvent[] = [];
		const manager = createManager(root, {
			invocation: { command: path.join(root, "missing-pi"), prefixArgs: [] },
			onLifecycle: (event) => events.push(event),
		});
		await manager.initialize();

		const started = await manager.start(definition, { task: "cannot spawn", mode: "foreground" });
		const failed = await started.completion;

		expect(failed.status).toBe("failed");
		expect(failed.error).toMatch(/ENOENT|not found|spawn/i);
		expect(events.some((event) => event.status === "completed")).toBe(false);
	});

	it("keeps successful stderr diagnostics out of terminal error state", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const started = await manager.start(definition, { task: "benign-stderr", mode: "foreground" });

		const completed = await started.completion;

		expect(completed.status).toBe("completed");
		expect(completed.error).toBeUndefined();
		expect(await manager.registry.readTranscript(completed.agentId)).toContain("Created new session");
	});

	it("completes a settled agent whose process does not exit", async () => {
		const root = temporaryDirectory();
		const notifications: AgentRecord[] = [];
		const manager = createManager(root, { onTerminal: (record) => notifications.push(record) });
		await manager.initialize();
		const started = await manager.start(definition, {
			task: "settle-hang ignore-term",
			mode: "background",
		});

		const completed = await started.completion;

		expect(completed.status).toBe("completed");
		expect(completed.lastOutput).toContain("finished");
		expect(await manager.registry.readTranscript(completed.agentId)).toContain('"type":"agent_settled"');
		expect(notifications).toHaveLength(1);
		expect(manager.getActiveCount()).toBe(0);
	});

	it("clears leftover registry state on initialize without restarting orphaned records", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const now = new Date().toISOString();
		const orphan: AgentRecord = {
			version: 2,
			agentId: "agent-orphan",
			runId: "run-orphan",
			parentSessionId: "parent-1",
			definition,
			task: "old task",
			mode: "background",
			status: "running",
			cwd: root,
			isolation: "none",
			metadata: {},
			createdAt: now,
			startedAt: now,
			updatedAt: now,
			childSessionId: "agent-orphan",
			childSessionDir: path.join(stateRoot, "sessions", "agent-orphan"),
			transcriptPath: path.join(stateRoot, "transcripts", "agent-orphan.jsonl"),
			usage: emptyUsage(),
			toolCount: 0,
			lastOutput: "",
			activities: [],
			notified: false,
			lifecycleEventId: "event-old",
		};
		fs.mkdirSync(orphan.childSessionDir, { recursive: true });
		fs.mkdirSync(path.dirname(orphan.transcriptPath), { recursive: true });
		fs.writeFileSync(orphan.transcriptPath, "stale\n");
		const registry = new AgentRegistry(stateRoot, "parent-1");
		await registry.save(orphan);
		const manager = createManager(root);

		await manager.initialize();

		expect(manager.get(orphan.agentId)).toBeUndefined();
		expect(manager.list()).toEqual([]);
		expect(manager.getActiveCount()).toBe(0);
		expect(fs.existsSync(orphan.transcriptPath)).toBe(false);
		expect(fs.existsSync(orphan.childSessionDir)).toBe(false);
		expect(fs.existsSync(path.join(stateRoot, "registries", "parent-1.json"))).toBe(false);
	});

	it("terminates a surviving child before recovering a crashed parent registry", async () => {
		const root = temporaryDirectory();
		const resultPath = path.join(root, "crash-result.json");
		execFileSync(process.execPath, ["--experimental-strip-types", crashParentPath, root, resultPath, fixturePath], {
			timeout: 5000,
		});
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { agentId: string; pid: number };
		expect(processIsAlive(result.pid)).toBe(true);

		const manager = createManager(root);
		await manager.initialize();

		expect(manager.get(result.agentId)).toBeUndefined();
		expect(processIsAlive(result.pid)).toBe(false);
	});

	it("terminates a child spawned before its PID could be persisted", async () => {
		const root = temporaryDirectory();
		const resultPath = path.join(root, "launch-crash-result.json");
		execFileSync(
			process.execPath,
			["--experimental-strip-types", crashParentPath, root, resultPath, fixturePath, "block-probe"],
			{ timeout: 5000 },
		);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { agentId: string; pid: number };
		expect(processIsAlive(result.pid)).toBe(true);

		try {
			const persistedBeforeRecovery = JSON.parse(
				fs.readFileSync(path.join(root, "state", "registries", "parent-1.json"), "utf8"),
			) as { records: AgentRecord[] };
			expect(persistedBeforeRecovery.records[0]?.status).toBe("queued");
			expect(persistedBeforeRecovery.records[0]?.pid).toBeUndefined();

			const manager = createManager(root);
			await manager.initialize();

			expect(manager.get(result.agentId)).toBeUndefined();
		} finally {
			if (processIsAlive(result.pid)) process.kill(result.pid, "SIGKILL");
			for (let attempt = 0; attempt < 100 && processIsAlive(result.pid); attempt++)
				await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(processIsAlive(result.pid)).toBe(false);
	});

	it("uses an injected Windows-style identity probe for safe recovery", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		if (child.pid === undefined) throw new Error("Expected child pid");
		const token = "windows:638895000000000000";
		const now = new Date().toISOString();
		const record: AgentRecord = {
			version: 2,
			agentId: "agent-windows-recovery",
			runId: "run-windows-recovery",
			parentSessionId: "parent-1",
			definition,
			task: "recover",
			mode: "background",
			status: "running",
			cwd: root,
			isolation: "none",
			metadata: {},
			createdAt: now,
			startedAt: now,
			updatedAt: now,
			childSessionId: "agent-windows-recovery",
			childSessionDir: path.join(stateRoot, "sessions", "agent-windows-recovery"),
			transcriptPath: path.join(stateRoot, "transcripts", "agent-windows-recovery.jsonl"),
			pid: child.pid,
			processStartToken: token,
			usage: emptyUsage(),
			toolCount: 0,
			lastOutput: "",
			activities: [],
			notified: false,
			lifecycleEventId: "event-windows-recovery",
		};
		const registry = new AgentRegistry(stateRoot, "parent-1");
		await registry.save(record);
		const unsafeManager = createManager(root, { processIdentityProbe: async () => undefined });
		await expect(unsafeManager.initialize()).rejects.toThrow("refusing unsafe recovery");
		expect(unsafeManager.get(record.agentId)?.status).toBe("running");
		const manager = createManager(root, {
			processIdentityProbe: async (pid) => (pid === child.pid && child.exitCode === null ? token : undefined),
		});

		await manager.initialize();

		expect(manager.get(record.agentId)).toBeUndefined();
		expect(processIsAlive(child.pid)).toBe(false);
	});

	it("propagates parent shutdown to active children", async () => {
		const root = temporaryDirectory();
		const manager = createManager(root);
		await manager.initialize();
		const started = await manager.start(definition, { task: "delay:10000", mode: "foreground" });
		await waitForStatus(manager, started.record.agentId, "running");

		await manager.shutdown();

		expect((await started.completion).status).toBe("interrupted");
	});

	it("removes session state on destroy after children finish", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const manager = createManager(root);
		await manager.initialize();
		const started = await manager.start(definition, { task: "inspect", mode: "foreground" });
		await started.completion;
		expect(fs.existsSync(started.record.transcriptPath)).toBe(true);
		expect(fs.existsSync(path.join(stateRoot, "registries", "parent-1.json"))).toBe(true);

		await manager.destroy();

		expect(fs.existsSync(started.record.transcriptPath)).toBe(false);
		expect(fs.existsSync(started.record.childSessionDir)).toBe(false);
		expect(fs.existsSync(path.join(stateRoot, "prompts", `${started.record.agentId}.md`))).toBe(false);
		expect(fs.existsSync(path.join(stateRoot, "registries", "parent-1.json"))).toBe(false);
		expect(manager.list()).toEqual([]);
	});

	it("keeps the worker pool snapshot on destroy", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const manager = createManager(root);
		await manager.initialize();
		await writeWorkerModels(stateRoot, [{ provider: "provider", id: "model", label: "Model" }]);
		expect(fs.existsSync(getWorkerModelsPath(stateRoot))).toBe(true);

		await manager.destroy();

		// The pool is shared configuration, not session state: it survives shutdown.
		expect(fs.existsSync(getWorkerModelsPath(stateRoot))).toBe(true);
	});

	it("removes the worktree branch on destroy", async () => {
		const root = temporaryDirectory();
		const repositoryPath = path.join(root, "repository");
		fs.mkdirSync(repositoryPath);
		const repository = fs.realpathSync(repositoryPath);
		execFileSync("git", ["init"], { cwd: repository });
		fs.writeFileSync(path.join(repository, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd: repository });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
			cwd: repository,
		});
		const manager = createManager(root, { defaultCwd: repository });
		await manager.initialize();
		const started = await manager.start(
			{ ...definition, isolation: "worktree" },
			{
				task: "inspect",
				mode: "foreground",
			},
		);
		await started.completion;
		const branch = `pi-subagent/${started.record.agentId}`;
		const branchExists = (): boolean => {
			try {
				execFileSync("git", ["-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
				return true;
			} catch {
				return false;
			}
		};
		expect(branchExists()).toBe(true);

		await manager.destroy();

		expect(branchExists()).toBe(false);
	});

	it("re-publishes active status with the persisted event ID for recovery probes", async () => {
		const root = temporaryDirectory();
		const events: AgentLifecycleEvent[] = [];
		const manager = createManager(root, { onLifecycle: (event) => events.push(event) });
		await manager.initialize();
		const now = new Date().toISOString();
		const queued: AgentRecord = {
			version: 2,
			agentId: "agent-probe",
			runId: "run-probe",
			parentSessionId: "parent-1",
			definition,
			task: "probe task",
			mode: "background",
			status: "queued",
			cwd: root,
			isolation: "none",
			metadata: { correlation: "opaque" },
			createdAt: now,
			updatedAt: now,
			childSessionId: "agent-probe",
			childSessionDir: path.join(root, "state", "sessions", "agent-probe"),
			transcriptPath: path.join(root, "state", "transcripts", "agent-probe.jsonl"),
			usage: emptyUsage(),
			toolCount: 0,
			lastOutput: "",
			activities: [],
			notified: false,
			lifecycleEventId: "event-probe",
		};
		await manager.registry.save(queued);

		manager.republishActive();

		expect(events.at(-1)).toMatchObject({
			agentId: queued.agentId,
			runId: queued.runId,
			status: "queued",
			eventId: queued.lifecycleEventId,
			metadata: queued.metadata,
		});
	});
});

describe("WorktreeService", () => {
	it("keeps a stable branch and its commits across worktree cleanup and resume", async () => {
		const root = temporaryDirectory();
		const repositoryPath = path.join(root, "repository");
		fs.mkdirSync(repositoryPath);
		// git resolves the /var symlink in the macOS temp directory when reporting
		// the repository toplevel, so use the real path for consistent comparisons.
		const repository = fs.realpathSync(repositoryPath);
		execFileSync("git", ["init"], { cwd: repository });
		fs.writeFileSync(path.join(repository, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd: repository });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
			cwd: repository,
		});
		const nestedCwd = path.join(repository, "packages", "worker");
		fs.mkdirSync(nestedCwd, { recursive: true });
		const service = new WorktreeService(path.join(root, "state"));

		const worktree = await service.create("agent-worktree", nestedCwd);
		expect(worktree.branch).toBe("pi-subagent/agent-worktree");
		expect(worktree.cwd).toBe(path.join(worktree.path, "packages", "worker"));
		expect(fs.existsSync(path.join(worktree.path, "README.md"))).toBe(true);
		fs.writeFileSync(path.join(worktree.path, "result.txt"), "preserved\n");
		execFileSync("git", ["add", "result.txt"], { cwd: worktree.path });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "result"], {
			cwd: worktree.path,
		});
		expect(await service.cleanup(worktree.path, repository)).toBeUndefined();
		expect(fs.existsSync(worktree.path)).toBe(false);

		const resumed = await service.create("agent-worktree", nestedCwd);
		expect(resumed).toEqual(worktree);
		expect(fs.readFileSync(path.join(resumed.path, "result.txt"), "utf8")).toBe("preserved\n");
		expect(execFileSync("git", ["branch", "--show-current"], { cwd: resumed.path, encoding: "utf8" }).trim()).toBe(
			worktree.branch,
		);
	});
});
