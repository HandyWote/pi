import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import { type AgentDefinition, type AgentLifecycleEvent, type AgentRecord, emptyUsage } from "../src/types.ts";
import { WorktreeService } from "../src/worktree.ts";

const fixturePath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
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

afterEach(() => {
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
		expect(events.every((event) => event.metadata["external/correlation"] === "value")).toBe(true);
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
		expect(failed.status).toBe("failed");
		expect(events.filter((event) => event.status === "running")).toHaveLength(1);

		const resumed = await manager.resume(failed.agentId, "resumed", "foreground");
		const completed = await resumed.completion;

		expect(completed.agentId).toBe(failed.agentId);
		expect(completed.childSessionId).toBe(failed.childSessionId);
		expect(completed.status).toBe("completed");
		expect(completed.usage.turns).toBe(3);
		expect(events.filter((event) => event.status === "running")).toHaveLength(2);
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

	it("marks orphaned running records interrupted without restarting them", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const now = new Date().toISOString();
		const orphan: AgentRecord = {
			version: 1,
			agentId: "agent-orphan",
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
		const registry = new AgentRegistry(stateRoot, "parent-1");
		await registry.save(orphan);
		const manager = createManager(root);

		await manager.initialize();

		expect(manager.get(orphan.agentId)?.status).toBe("interrupted");
		expect(manager.getActiveCount()).toBe(0);
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

	it("re-publishes active status with the persisted event ID for recovery probes", async () => {
		const root = temporaryDirectory();
		const events: AgentLifecycleEvent[] = [];
		const manager = createManager(root, { onLifecycle: (event) => events.push(event) });
		await manager.initialize();
		const now = new Date().toISOString();
		const queued: AgentRecord = {
			version: 1,
			agentId: "agent-probe",
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
			status: "queued",
			eventId: queued.lifecycleEventId,
			metadata: queued.metadata,
		});
	});
});

describe("WorktreeService", () => {
	it("creates and cleanly removes a detached worktree", async () => {
		const root = temporaryDirectory();
		const repository = path.join(root, "repository");
		fs.mkdirSync(repository);
		execFileSync("git", ["init"], { cwd: repository });
		fs.writeFileSync(path.join(repository, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd: repository });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
			cwd: repository,
		});
		const service = new WorktreeService(path.join(root, "state"));

		const worktree = await service.create("agent-worktree", repository);
		expect(fs.existsSync(path.join(worktree, "README.md"))).toBe(true);
		expect(await service.cleanup(worktree, repository)).toBeUndefined();
		expect(fs.existsSync(worktree)).toBe(false);
	});
});
