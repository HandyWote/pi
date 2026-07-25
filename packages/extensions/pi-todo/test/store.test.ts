import { describe, expect, it } from "vitest";
import { parseTodoAgentDescription } from "../src/events.ts";
import { resolveWaves } from "../src/scheduler.ts";
import { TodoStore } from "../src/store.ts";
import type { TodoDefinition } from "../src/types.ts";

function task(
	id: string,
	depends_on: string[] = [],
	overrides: Partial<Omit<TodoDefinition, "id" | "depends_on">> = {},
): TodoDefinition {
	return {
		id,
		title: `Task ${id}`,
		depends_on,
		acceptance_criteria: [`${id} is complete`],
		size_hint: "small",
		...overrides,
	};
}

describe("resolveWaves", () => {
	it("assigns deterministic topological waves", () => {
		const waves = resolveWaves([task("T1"), task("T2"), task("T3", ["T1", "T2"]), task("T4", ["T3"])]);
		expect([...waves.entries()]).toEqual([
			["T1", 1],
			["T2", 1],
			["T3", 2],
			["T4", 3],
		]);
	});

	it("rejects malformed graphs", () => {
		expect(() => resolveWaves([task("T1"), task("T1")])).toThrow('Duplicate todo id "T1"');
		expect(() => resolveWaves([task("T1", ["missing"])])).toThrow('depends on unknown todo "missing"');
		expect(() => resolveWaves([task("T1", ["T2"]), task("T2", ["T1"])])).toThrow("contains a cycle");
	});
});

describe("TodoStore", () => {
	it("holds the wave barrier until every active task is reviewed", () => {
		const store = new TodoStore();
		store.write({
			global_direction: "Implement the feature",
			items: [task("T1"), task("T2"), task("T3", ["T1", "T2"])],
		});

		const first = store.nextWave();
		expect(first.tasks.map((item) => item.id)).toEqual(["T1", "T2"]);
		expect(store.nextWave()).toMatchObject({ wave: 1, tasks: [], waiting: true });

		expect(store.bindAgent("T1", "agent-1")).toBe(true);
		expect(() => store.mark("T1", "done")).toThrow('still running in agent "agent-1"');
		expect(store.settleAgent("agent-1", true)).toBe(true);
		expect(store.getItem("T1")?.status).toBe("executed");
		store.mark("T1", "done");
		expect(store.nextWave()).toMatchObject({ wave: 1, tasks: [], waiting: true });

		store.mark("T2", "done");
		expect(store.nextWave()).toMatchObject({ wave: 2, tasks: [{ id: "T3" }], waiting: false });
	});

	it("blocks failed descendants while continuing independent branches", () => {
		const store = new TodoStore();
		store.write({
			global_direction: "Implement independent branches",
			items: [task("A"), task("B"), task("A2", ["A"]), task("B2", ["B"])],
		});
		store.nextWave();
		store.mark("A", "failed", "execution failed");
		store.mark("B", "done");

		expect(store.getItem("A2")?.status).toBe("blocked");
		expect(store.nextWave()).toMatchObject({ wave: 2, tasks: [{ id: "B2" }] });
	});

	it("enforces two fix rounds", () => {
		const store = new TodoStore();
		store.write({ global_direction: "Fix the task", items: [task("T1")] });
		store.nextWave();

		store.mark("T1", "fix-needed");
		store.bindAgent("T1", "fix-1");
		store.settleAgent("fix-1", true);
		store.mark("T1", "fix-needed");
		store.bindAgent("T1", "fix-2");
		store.settleAgent("fix-2", true);
		const exhausted = store.mark("T1", "fix-needed");

		expect(exhausted.exhausted).toBe(true);
		expect(exhausted.item.status).toBe("failed");
		expect(exhausted.item.fix_attempts).toBe(3);
	});

	it("allows one off-target reassignment and reblocks descendants on failure", () => {
		const store = new TodoStore();
		store.write({ global_direction: "Stay on target", items: [task("T1"), task("T2", ["T1"])] });
		store.nextWave();
		store.mark("T1", "off-target");
		expect(store.getItem("T2")?.status).toBe("blocked");

		expect(store.bindAgent("T1", "retry-1")).toBe(true);
		expect(store.getItem("T2")?.status).toBe("pending");
		store.settleAgent("retry-1", true);
		const exhausted = store.mark("T1", "off-target");

		expect(exhausted.exhausted).toBe(true);
		expect(exhausted.item.status).toBe("failed");
		expect(store.getItem("T2")?.status).toBe("blocked");
	});

	it("parses only exact lifecycle descriptions", () => {
		expect(parseTodoAgentDescription("pi-todo:T1")).toBe("T1");
		expect(parseTodoAgentDescription("pi-todo:T1 review")).toBeUndefined();
		expect(parseTodoAgentDescription("other:T1")).toBeUndefined();
	});
});
