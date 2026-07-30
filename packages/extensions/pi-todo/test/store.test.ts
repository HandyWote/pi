import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBlockedTasks, getReadyTasks, validateDefinitions } from "../src/scheduler.ts";
import { FileTodoStore, TodoPersistenceError } from "../src/store.ts";
import type { TodoDefinition, TodoTask } from "../src/types.ts";

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
			{ ...task("A"), status: "in_progress", owner: "main", claim_token: "a", created_at: "x", updated_at: "x", revision: 1 },
			{ ...task("B"), status: "pending", created_at: "x", updated_at: "x", revision: 1 },
			{ ...task("C", ["A"]), status: "pending", created_at: "x", updated_at: "x", revision: 1 },
		];
		expect(getReadyTasks(tasks).map((item) => item.id)).toEqual(["B"]);
		expect(getBlockedTasks(tasks).map((item) => item.id)).toEqual(["C"]);
	});

	it("rejects duplicates, unknown dependencies, and cycles", () => {
		expect(() => validateDefinitions([task("A"), task("A")])).toThrow('Duplicate todo id "A"');
		expect(() => validateDefinitions([task("A", ["missing"])]))
			.toThrow('depends on unknown todo "missing"');
		expect(() => validateDefinitions([task("A", ["B"]), task("B", ["A"])]))
			.toThrow("contains a cycle");
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

	it("claims atomically and releases only matching ownership", async () => {
		await store.create("Parallel work", [task("A")], "list-1");
		const competingStore = new FileTodoStore(directory);
		const results = await Promise.allSettled([
			store.claim("list-1", "A", "agent-1", 1),
			competingStore.claim("list-1", "A", "agent-2", 1),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const claimed = await store.read("list-1");
		const claimedTask = claimed.tasks[0];
		expect(claimedTask?.status).toBe("in_progress");
		await expect(store.release("list-1", "A", "wrong", claimedTask?.claim_token ?? "")).rejects.toThrow(
			"not owned",
		);
		await store.release("list-1", "A", claimedTask?.owner ?? "", claimedTask?.claim_token ?? "");
		const released = (await store.read("list-1")).tasks[0];
		expect(released?.status).toBe("pending");
		expect(released?.owner).toBeUndefined();
	});

	it("has only three public states and completes without review or retry state", async () => {
		await store.create("Finish directly", [task("A")], "list-1");
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

	it("recovers a corrupt primary from backup with a diagnostic", async () => {
		await store.create("Recover", [task("A")], "list-1");
		await store.add("list-1", [task("B")]);
		await writeFile(join(directory, "list-1", "tasks.json"), "{partial", "utf8");

		const recovered = await store.read("list-1");
		expect(recovered.tasks.map((item) => item.id)).toEqual(["A"]);
		expect(store.takeDiagnostic()).toContain("Recovered todo list");
		expect(JSON.parse(await readFile(join(directory, "list-1", "tasks.json.bak"), "utf8"))).toBeDefined();
	});

	it("reports corrupt persistence when no backup exists", async () => {
		await store.create("Corrupt", [task("A")], "list-1");
		await writeFile(join(directory, "list-1", "tasks.json"), "{partial", "utf8");
		await expect(store.read("list-1")).rejects.toBeInstanceOf(TodoPersistenceError);
	});
});
