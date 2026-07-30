import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBlockedTasks, getReadyTasks, validateDefinitions } from "../src/scheduler.ts";
import { FileTodoStore, TodoPersistenceError } from "../src/store.ts";
import type { TodoDefinition, TodoTask } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const CLAIM_WORKER = new URL("./fixtures/claim-worker.ts", import.meta.url);
const CRASH_LOCK_WORKER = new URL("./fixtures/crash-lock-worker.ts", import.meta.url);

function task(id: string, depends_on: string[] = []): TodoDefinition {
	return {
		id,
		subject: `Task ${id}`,
		description: `Implement ${id}`,
		depends_on,
		acceptance_criteria: [`${id} is complete`],
	};
}

describe("dependency graph", () => {
	it("selects every independent ready task without a wave barrier", () => {
		const tasks: TodoTask[] = [
			{
				...task("A"),
				status: "in_progress",
				owner: "main",
				claim_token: "a",
				created_at: "x",
				updated_at: "x",
				revision: 1,
			},
			{ ...task("B"), status: "pending", created_at: "x", updated_at: "x", revision: 1 },
			{ ...task("C", ["A"]), status: "pending", created_at: "x", updated_at: "x", revision: 1 },
		];
		expect(getReadyTasks(tasks).map((item) => item.id)).toEqual(["B"]);
		expect(getBlockedTasks(tasks).map((item) => item.id)).toEqual(["C"]);
	});

	it("rejects duplicates, unknown dependencies, and cycles", () => {
		expect(() => validateDefinitions([task("A"), task("A")])).toThrow('Duplicate todo id "A"');
		expect(() => validateDefinitions([task("A", ["missing"])])).toThrow('depends on unknown todo "missing"');
		expect(() => validateDefinitions([task("A", ["B"]), task("B", ["A"])])).toThrow("contains a cycle");
	});
});

describe("FileTodoStore", () => {
	let directory: string;
	let store: FileTodoStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-todo-store-"));
		store = new FileTodoStore(directory);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("supports dynamic add, update, dependency cleanup, and tombstones", async () => {
		await store.create("Ship the feature", [task("A"), task("B", ["A"])], "list-1");
		await store.add("list-1", [task("C", ["B"])]);
		await store.update("list-1", "C", {
			subject: "Updated C",
			description: "new details",
			depends_on: ["A"],
			acceptance_criteria: ["verified"],
		});
		const list = await store.delete("list-1", "A");

		expect(list.tasks.map((item) => item.id)).toEqual(["B", "C"]);
		expect(list.tasks.every((item) => item.depends_on.length === 0)).toBe(true);
		expect(list.tasks.find((item) => item.id === "C")).toMatchObject({
			subject: "Updated C",
			description: "new details",
			acceptance_criteria: ["verified"],
		});
		expect(list.tombstones).toEqual([expect.objectContaining({ id: "A" })]);
		expect(list.history.length).toBe(3);
	});

	it("claims atomically across processes and releases only matching ownership", async () => {
		await store.create("Parallel work", [task("A")], "list-1");
		const results = await Promise.allSettled([
			execFileAsync(process.execPath, [CLAIM_WORKER.pathname, directory, "agent-1"]),
			execFileAsync(process.execPath, [CLAIM_WORKER.pathname, directory, "agent-2"]),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const claimed = await store.read("list-1");
		const claimedTask = claimed.tasks[0];
		expect(claimedTask?.status).toBe("in_progress");
		await expect(store.release("list-1", "A", "wrong", claimedTask?.claim_token ?? "")).rejects.toThrow("not owned");
		await store.release("list-1", "A", claimedTask?.owner ?? "", claimedTask?.claim_token ?? "");
		const released = (await store.read("list-1")).tasks[0];
		expect(released?.status).toBe("pending");
		expect(released?.owner).toBeUndefined();
	});

	it("requires claims for in_progress and a matching token for claimed updates", async () => {
		await store.create("Protected work", [task("A")], "list-1");
		await expect(store.update("list-1", "A", { status: "in_progress" })).rejects.toThrow("through todo_claim");
		const claim = await store.claim("list-1", "A", "agent-1");
		await expect(store.update("list-1", "A", { status: "completed" })).rejects.toThrow("current claim token");
		await store.update("list-1", "A", { status: "completed", claim_token: claim.claim_token });
		expect((await store.read("list-1")).tasks[0]?.status).toBe("completed");
	});

	it("transfers ownership idempotently and rejects stale lifecycle tokens", async () => {
		await store.create("Delegate safely", [task("A")], "list-1");
		const initial = await store.claim("list-1", "A", "main");
		const transferred = await store.transfer("list-1", "A", "agent-1", initial.claim_token);
		const transferredRevision = transferred.revision;
		expect(transferred.tasks[0]?.owner).toBe("agent-1");
		expect((await store.transfer("list-1", "A", "agent-1", initial.claim_token)).revision).toBe(transferredRevision);
		await store.release("list-1", "A", "agent-1", initial.claim_token);
		const current = await store.claim("list-1", "A", "agent-2");
		await expect(store.transfer("list-1", "A", "stale-agent", initial.claim_token)).rejects.toThrow("does not match");
		expect((await store.read("list-1")).tasks[0]).toMatchObject({
			owner: "agent-2",
			claim_token: current.claim_token,
		});
	});

	it("reclaims a lock left by a dead process", async () => {
		await store.create("Recover lock", [task("A")], "list-1");
		await execFileAsync(process.execPath, [CRASH_LOCK_WORKER.pathname, directory]);
		const results = await Promise.allSettled([
			execFileAsync(process.execPath, [CLAIM_WORKER.pathname, directory, "agent-1"]),
			execFileAsync(process.execPath, [CLAIM_WORKER.pathname, directory, "agent-2"]),
			execFileAsync(process.execPath, [CLAIM_WORKER.pathname, directory, "agent-3"]),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const claimed = (await store.read("list-1")).tasks[0];
		expect(claimed?.status).toBe("in_progress");
		expect(["agent-1", "agent-2", "agent-3"]).toContain(claimed?.owner);
	});

	it("keeps a fully published choosing contender exclusive while initialization is paused", async () => {
		await store.create("Pause lock initialization", [task("A")], "list-1");
		let markPublished: (() => void) | undefined;
		const published = new Promise<void>((resolve) => {
			markPublished = resolve;
		});
		let resumeInitialization: (() => void) | undefined;
		const resume = new Promise<void>((resolve) => {
			resumeInitialization = resolve;
		});
		let shouldPause = true;
		const pausedStore = new FileTodoStore(directory, {
			async lockHook(phase) {
				if (phase !== "published" || !shouldPause) return;
				shouldPause = false;
				markPublished?.();
				await resume;
			},
		});
		const first = pausedStore.claim("list-1", "A", "agent-1");
		await published;
		let secondSettled = false;
		const second = store.claim("list-1", "A", "agent-2").finally(() => {
			secondSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(secondSettled).toBe(false);
		resumeInitialization?.();
		const results = await Promise.allSettled([first, second]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	});

	it("reconciles orphaned owners while preserving owners with live evidence", async () => {
		await store.create("Recover owners", [task("A"), task("B")], "list-1");
		await store.claim("list-1", "A", "session-1");
		await store.claim("list-1", "B", "agent-orphan");
		const reconciled = await store.reconcileOwners("list-1", new Set(["session-1"]));
		expect(reconciled.tasks.find((item) => item.id === "A")).toMatchObject({
			status: "in_progress",
			owner: "session-1",
		});
		expect(reconciled.tasks.find((item) => item.id === "B")).toMatchObject({
			status: "pending",
			owner: undefined,
			claim_token: undefined,
		});
	});

	it("rejects list path traversal before creating a lock", async () => {
		await expect(store.create("Escape", [task("A")], "../escape")).rejects.toThrow("Invalid todo list id");
	});

	it("has only three public states and completes without review or retry state", async () => {
		await store.create("Finish directly", [task("A")], "list-1");
		await expect(store.update("list-1", "A", { status: "completed" })).rejects.toThrow("claimed before completion");
		const claim = await store.claim("list-1", "A", "main");
		const completed = await store.update("list-1", "A", {
			status: "completed",
			claim_token: claim.claim_token,
		});
		expect(completed.tasks[0]?.status).toBe("completed");
		expect(Object.keys(completed.tasks[0] ?? {})).not.toContain("retry");
		expect((await store.view("list-1")).summary).toEqual({
			total: 1,
			pending: 0,
			in_progress: 0,
			completed: 1,
			ready: 0,
			blocked: 0,
		});
	});

	it("restores historical revisions when cloning a branch", async () => {
		await store.create("Branch work", [task("A")], "source");
		await store.add("source", [task("B")]);
		await store.add("source", [task("C")]);
		const clone = await store.clone("source", 2, "forked");
		expect(clone.tasks.map((item) => item.id)).toEqual(["A", "B"]);
		expect((await store.read("source")).tasks.map((item) => item.id)).toEqual(["A", "B", "C"]);
	});

	it("keeps document history bounded while retaining old revision snapshots", async () => {
		await store.create("Long history", [task("A")], "list-1");
		for (let revision = 2; revision <= 23; revision++) {
			await store.update("list-1", "A", { subject: `Task A revision ${revision}` });
		}
		const current = await store.read("list-1");
		expect(current.history).toHaveLength(20);
		expect((await store.read("list-1", 1)).tasks[0]?.subject).toBe("Task A");
	});

	it("garbage-collects revision snapshots at the configured retention boundary", async () => {
		const limited = new FileTodoStore(directory, { revisionSnapshotLimit: 2 });
		await limited.create("Bound snapshots", [task("A")], "limited");
		for (let revision = 2; revision <= 5; revision++) {
			await limited.update("limited", "A", { subject: `Task A revision ${revision}` });
		}
		expect((await readdir(join(directory, "limited", "revisions"))).sort()).toEqual(["3.json", "4.json"]);
	});

	it("does not inherit live claims into a fork or overwrite an existing target", async () => {
		await store.create("Fork safely", [task("A")], "source");
		await store.claim("source", "A", "agent-1");
		await store.create("Existing", [task("B")], "target");
		await expect(store.clone("source", undefined, "target")).rejects.toThrow("already exists");
		const fork = await store.clone("source", undefined, "fork");
		expect(fork.tasks[0]?.status).toBe("pending");
		expect(fork.tasks[0]?.owner).toBeUndefined();
		expect(fork.tasks[0]?.claim_token).toBeUndefined();
	});

	it("updates dependent revisions on deletion and forbids tombstone id reuse", async () => {
		await store.create("Delete safely", [task("A"), task("B", ["A"])], "list-1");
		const before = (await store.read("list-1")).tasks.find((item) => item.id === "B");
		const deleted = await store.delete("list-1", "A");
		const after = deleted.tasks.find((item) => item.id === "B");
		expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
		expect(after?.updated_at).not.toBe(before?.updated_at);
		await expect(store.add("list-1", [task("A")])).rejects.toThrow("id cannot be reused");
	});

	it("recovers a corrupt primary from backup with a diagnostic", async () => {
		await store.create("Recover", [task("A")], "list-1");
		await store.add("list-1", [task("B")]);
		await writeFile(join(directory, "list-1", "tasks.json"), "{partial", "utf8");

		const recovered = await store.read("list-1");
		expect(recovered.tasks.map((item) => item.id)).toEqual(["A"]);
		expect(store.takeDiagnostic()).toContain("Recovered todo list");
		expect(JSON.parse(await readFile(join(directory, "list-1", "tasks.json"), "utf8"))).toBeDefined();
		await writeFile(join(directory, "list-1", "tasks.json"), "{partial-again", "utf8");
		expect((await store.read("list-1")).tasks.map((item) => item.id)).toEqual(["A"]);
	});

	it("rejects malformed task state and a document id that does not match its locked directory", async () => {
		await store.create("Corrupt", [task("A")], "list-1");
		await store.add("list-1", [task("B")]);
		const malformed = await store.read("list-1");
		malformed.id = "other";
		malformed.tasks[0]!.status = "invalid" as TodoTask["status"];
		const serialized = JSON.stringify(malformed);
		await writeFile(join(directory, "list-1", "tasks.json"), serialized, "utf8");
		await writeFile(join(directory, "list-1", "tasks.json.bak"), serialized, "utf8");
		await expect(store.read("list-1")).rejects.toBeInstanceOf(TodoPersistenceError);
	});
});
