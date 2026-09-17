import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager, getWorkerModelsPath } from "../src/manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import { type AgentDefinition, type AgentRecord, emptyUsage } from "../src/types.ts";
import { WorktreeService } from "../src/worktree.ts";

const fixturePath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
const DAY_MS = 24 * 3600 * 1000;
const tempRoots: string[] = [];
const children: ChildProcess[] = [];
const definition: AgentDefinition = {
	name: "worker",
	description: "Startup sweep worker",
	tools: ["read"],
	model: "faux-model",
	systemPrompt: "Complete the delegated task.",
	source: "user",
	filePath: "/tmp/worker.md",
	isolation: "none",
};

function temporaryDirectory(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sweep-"));
	tempRoots.push(root);
	return root;
}

function createManager(
	root: string,
	overrides: Partial<ConstructorParameters<typeof AgentManager>[0]> = {},
): AgentManager {
	return new AgentManager({
		rootDir: path.join(root, "state"),
		parentSessionId: "parent-current",
		defaultCwd: root,
		invocation: { command: process.execPath, prefixArgs: [fixturePath] },
		killGraceMs: 40,
		...overrides,
	});
}

function foreignRecord(
	stateRoot: string,
	parentSessionId: string,
	agentId: string,
	overrides: Partial<AgentRecord> = {},
): AgentRecord {
	const now = new Date().toISOString();
	return {
		version: 2,
		agentId,
		runId: `run-${agentId}`,
		parentSessionId,
		definition: { ...definition },
		task: "sweep test",
		mode: "background",
		status: "completed",
		cwd: path.dirname(stateRoot),
		isolation: "none",
		metadata: {},
		createdAt: now,
		updatedAt: now,
		childSessionId: agentId,
		childSessionDir: path.join(stateRoot, "sessions", agentId),
		usage: emptyUsage(),
		toolCount: 0,
		lastOutput: "",
		activities: [],
		notified: false,
		lifecycleEventId: `event-${agentId}`,
		...overrides,
	};
}

async function writeForeignRegistry(
	stateRoot: string,
	parentSessionId: string,
	records: AgentRecord[],
): Promise<string> {
	const registry = new AgentRegistry(stateRoot, parentSessionId);
	for (const record of records) await registry.save(record);
	return registry.registryPath;
}

async function agePath(target: string, days: number): Promise<void> {
	const time = new Date(Date.now() - days * DAY_MS);
	await fs.promises.utimes(target, time, time);
}

function spawnIdleChild(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	return child;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return error instanceof Error && "code" in error && error.code !== "ESRCH";
	}
}

async function waitForChildExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 200 && processIsAlive(pid); attempt++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(processIsAlive(pid)).toBe(false);
}

function createRepository(root: string): string {
	const repositoryPath = path.join(root, "repository");
	fs.mkdirSync(repositoryPath);
	const repository = fs.realpathSync(repositoryPath);
	execFileSync("git", ["init"], { cwd: repository });
	fs.writeFileSync(path.join(repository, "README.md"), "test\n");
	execFileSync("git", ["add", "README.md"], { cwd: repository });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd: repository,
	});
	return repository;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.pid === undefined) continue;
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("startup sweep", () => {
	it("leaves fresh foreign registries and their live children alone", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const child = spawnIdleChild();
		const record = foreignRecord(stateRoot, "parent-fresh", "agent-fresh", {
			status: "running",
			pid: child.pid,
			processStartToken: "proc:fresh",
		});
		const registryPath = await writeForeignRegistry(stateRoot, "parent-fresh", [record]);
		fs.mkdirSync(record.childSessionDir, { recursive: true });

		const manager = createManager(root, {
			processIdentityProbe: async (pid) => (pid === child.pid && child.exitCode === null ? "proc:fresh" : undefined),
		});
		await manager.initialize();

		expect(fs.existsSync(registryPath)).toBe(true);
		expect(fs.existsSync(record.childSessionDir)).toBe(true);
		expect(processIsAlive(child.pid!)).toBe(true);
	});

	it("sweeps a stale foreign registry: terminates orphans, deletes the registry, reclaims files", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const repository = createRepository(root);
		const runningChild = spawnIdleChild();
		const queuedChild = spawnIdleChild();
		const runningRecord = foreignRecord(stateRoot, "parent-stale", "agent-stale-running", {
			status: "running",
			pid: runningChild.pid,
			processStartToken: "proc:running",
			cwd: repository,
			isolation: "worktree",
			worktreePath: path.join(stateRoot, "worktrees", "agent-stale-running"),
			worktreeBranch: "pi-subagent/agent-stale-running",
		});
		const queuedRecord = foreignRecord(stateRoot, "parent-stale", "agent-stale-queued", {
			status: "queued",
		});
		const worktrees = new WorktreeService(stateRoot);
		const worktree = await worktrees.create(runningRecord.agentId, repository);
		const registryPath = await writeForeignRegistry(stateRoot, "parent-stale", [runningRecord, queuedRecord]);
		for (const record of [runningRecord, queuedRecord]) {
			const transcriptFilePath = path.join(stateRoot, "transcripts", `${record.agentId}.jsonl`);
			fs.mkdirSync(record.childSessionDir, { recursive: true });
			fs.mkdirSync(path.dirname(transcriptFilePath), { recursive: true });
			fs.writeFileSync(transcriptFilePath, "stale transcript\n");
			fs.mkdirSync(path.join(stateRoot, "prompts"), { recursive: true });
			fs.writeFileSync(path.join(stateRoot, "prompts", `${record.agentId}.md`), "prompt\n");
		}
		await agePath(registryPath, 8);
		for (const record of [runningRecord, queuedRecord])
			await agePath(path.join(stateRoot, "transcripts", `${record.agentId}.jsonl`), 8);
		await agePath(path.join(stateRoot, "prompts", `${runningRecord.agentId}.md`), 8);

		const manager = createManager(root, {
			defaultCwd: repository,
			processIdentityProbe: async (pid) => {
				if (pid === runningChild.pid && runningChild.exitCode === null) return "proc:running";
				if (pid === queuedChild.pid && queuedChild.exitCode === null) return "proc:queued";
				return undefined;
			},
			sessionProcessProbe: async (sessionId) =>
				sessionId === queuedRecord.childSessionId && queuedChild.exitCode === null && queuedChild.pid !== undefined
					? [queuedChild.pid]
					: [],
		});
		await manager.initialize();

		await waitForChildExit(runningChild.pid!);
		await waitForChildExit(queuedChild.pid!);
		expect(fs.existsSync(registryPath)).toBe(false);
		for (const record of [runningRecord, queuedRecord]) {
			expect(fs.existsSync(record.childSessionDir)).toBe(false);
			expect(fs.existsSync(path.join(stateRoot, "prompts", `${record.agentId}.md`))).toBe(false);
		}
		// Transcripts are not referenced anymore and their mtimes are past the
		// window, so the orphan sweep reclaims them.
		for (const record of [runningRecord, queuedRecord]) {
			expect(fs.existsSync(path.join(stateRoot, "transcripts", `${record.agentId}.jsonl`))).toBe(false);
		}
		// The retained worktree is force-removed and its branch deleted.
		expect(fs.existsSync(worktree.path)).toBe(false);
		let branchExists = true;
		try {
			execFileSync("git", ["-C", repository, "show-ref", "--verify", "--quiet", runningRecord.worktreeBranch!]);
		} catch {
			branchExists = false;
		}
		expect(branchExists).toBe(false);
	});

	it("does not kill a running child when its identity cannot be verified but still reclaims files", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const child = spawnIdleChild();
		const record = foreignRecord(stateRoot, "parent-stale", "agent-unverifiable", {
			status: "running",
			pid: child.pid,
			processStartToken: "proc:original",
		});
		const registryPath = await writeForeignRegistry(stateRoot, "parent-stale", [record]);
		fs.mkdirSync(record.childSessionDir, { recursive: true });
		await agePath(registryPath, 8);

		const manager = createManager(root, { processIdentityProbe: async () => undefined });
		await manager.initialize();

		expect(processIsAlive(child.pid!)).toBe(true);
		expect(fs.existsSync(registryPath)).toBe(false);
		expect(fs.existsSync(record.childSessionDir)).toBe(false);
	});

	it("does not kill a running child when its recorded identity no longer matches", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const child = spawnIdleChild();
		const record = foreignRecord(stateRoot, "parent-stale", "agent-mismatch", {
			status: "running",
			pid: child.pid,
			processStartToken: "proc:original",
		});
		const registryPath = await writeForeignRegistry(stateRoot, "parent-stale", [record]);
		fs.mkdirSync(record.childSessionDir, { recursive: true });
		await agePath(registryPath, 8);

		const manager = createManager(root, {
			processIdentityProbe: async (pid) =>
				pid === child.pid && child.exitCode === null ? "proc:reused" : undefined,
		});
		await manager.initialize();

		expect(processIsAlive(child.pid!)).toBe(true);
		expect(fs.existsSync(registryPath)).toBe(false);
		expect(fs.existsSync(record.childSessionDir)).toBe(false);
	});

	it("sweeps orphaned residue but keeps fresh and referenced entries", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		const freshReferencedRecord = foreignRecord(stateRoot, "parent-fresh", "agent-referenced");
		await writeForeignRegistry(stateRoot, "parent-fresh", [freshReferencedRecord]);

		const staleSessionDir = path.join(stateRoot, "sessions", "agent-stale-session");
		fs.mkdirSync(staleSessionDir, { recursive: true });
		fs.writeFileSync(path.join(staleSessionDir, "session.jsonl"), "{}\n");
		const freshSessionDir = path.join(stateRoot, "sessions", "agent-fresh-session");
		fs.mkdirSync(freshSessionDir, { recursive: true });
		const referencedSessionDir = path.join(stateRoot, "sessions", freshReferencedRecord.agentId);
		fs.mkdirSync(referencedSessionDir, { recursive: true });

		fs.mkdirSync(path.join(stateRoot, "prompts"), { recursive: true });
		fs.writeFileSync(path.join(stateRoot, "prompts", "agent-stale.md"), "stale\n");
		fs.writeFileSync(path.join(stateRoot, "prompts", "agent-fresh.md"), "fresh\n");
		fs.writeFileSync(path.join(stateRoot, "prompts", `${freshReferencedRecord.agentId}.md`), "referenced\n");

		fs.mkdirSync(path.join(stateRoot, "transcripts"), { recursive: true });
		fs.writeFileSync(path.join(stateRoot, "transcripts", "agent-stale.jsonl"), "stale\n");
		fs.writeFileSync(path.join(stateRoot, "transcripts", "agent-fresh.jsonl"), "fresh\n");
		fs.writeFileSync(path.join(stateRoot, "transcripts", `${freshReferencedRecord.agentId}.jsonl`), "referenced\n");

		const repository = createRepository(root);
		const worktrees = new WorktreeService(stateRoot);
		const orphanedWorktree = await worktrees.create("agent-orphan-worktree", repository);
		const freshWorktree = await worktrees.create("agent-fresh-worktree", repository);

		await agePath(staleSessionDir, 8);
		await agePath(referencedSessionDir, 8);
		await agePath(path.join(stateRoot, "prompts", "agent-stale.md"), 8);
		await agePath(path.join(stateRoot, "prompts", `${freshReferencedRecord.agentId}.md`), 8);
		await agePath(path.join(stateRoot, "transcripts", "agent-stale.jsonl"), 8);
		await agePath(path.join(stateRoot, "transcripts", `${freshReferencedRecord.agentId}.jsonl`), 8);
		await agePath(orphanedWorktree.path, 8);

		await fs.promises.writeFile(getWorkerModelsPath(stateRoot), "[]\n");

		const manager = createManager(root, { defaultCwd: repository });
		await manager.initialize();

		expect(fs.existsSync(staleSessionDir)).toBe(false);
		expect(fs.existsSync(path.join(stateRoot, "prompts", "agent-stale.md"))).toBe(false);
		expect(fs.existsSync(path.join(stateRoot, "transcripts", "agent-stale.jsonl"))).toBe(false);
		expect(fs.existsSync(orphanedWorktree.path)).toBe(false);

		expect(fs.existsSync(freshSessionDir)).toBe(true);
		expect(fs.existsSync(path.join(stateRoot, "prompts", "agent-fresh.md"))).toBe(true);
		expect(fs.existsSync(path.join(stateRoot, "transcripts", "agent-fresh.jsonl"))).toBe(true);
		expect(fs.existsSync(freshWorktree.path)).toBe(true);
		// Referenced entries survive even when their own mtime is past the window.
		expect(fs.existsSync(referencedSessionDir)).toBe(true);
		expect(fs.existsSync(path.join(stateRoot, "prompts", `${freshReferencedRecord.agentId}.md`))).toBe(true);
		expect(fs.existsSync(path.join(stateRoot, "transcripts", `${freshReferencedRecord.agentId}.jsonl`))).toBe(true);
		// The shared worker-pool snapshot is never touched.
		expect(fs.existsSync(getWorkerModelsPath(stateRoot))).toBe(true);
	});

	it("deletes stale registry temp files and keeps fresh ones", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		fs.mkdirSync(path.join(stateRoot, "registries"), { recursive: true });
		const staleTemp = path.join(stateRoot, "registries", "parent-old.json.1234.abcd.tmp");
		const freshTemp = path.join(stateRoot, "registries", "parent-new.json.5678.efgh.tmp");
		fs.writeFileSync(staleTemp, "{}");
		fs.writeFileSync(freshTemp, "{}");
		await agePath(staleTemp, 8);

		const manager = createManager(root);
		await manager.initialize();

		expect(fs.existsSync(staleTemp)).toBe(false);
		expect(fs.existsSync(freshTemp)).toBe(true);
	});

	it("deletes corrupt stale foreign registries", async () => {
		const root = temporaryDirectory();
		const stateRoot = path.join(root, "state");
		fs.mkdirSync(path.join(stateRoot, "registries"), { recursive: true });
		const corruptPath = path.join(stateRoot, "registries", "parent-corrupt.json");
		fs.writeFileSync(corruptPath, "{ not json");
		await agePath(corruptPath, 8);

		const manager = createManager(root);
		await manager.initialize();

		expect(fs.existsSync(corruptPath)).toBe(false);
		expect(manager.list()).toEqual([]);
	});
});
