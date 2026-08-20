import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SendMessageOptions,
	SessionEntry,
	Theme,
} from "@handy_wote/pi-coding-agent";
import { createEventBus } from "@handy_wote/pi-coding-agent";
import { visibleWidth } from "@handy_wote/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_LIFECYCLE_CHANNEL, registerAgentLifecycleProtocol } from "../src/protocol.ts";
import { TODO_BINDING_ENTRY, TodoRuntime } from "../src/runtime.ts";
import type { TodoBindingEntry } from "../src/types.ts";
import { renderTodoLines } from "../src/widget.ts";

interface FakeEnvironment {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	entries: SessionEntry[];
	messages: Array<{ customType: string; content: string; options?: SendMessageOptions }>;
	cancelledMessages: string[];
	notifications: Array<{ message: string; level: string }>;
	eventBus: ReturnType<typeof createEventBus>;
}

function fakeEnvironment(sessionId: string, initialEntries: SessionEntry[] = []): FakeEnvironment {
	const entries = [...initialEntries];
	const messages: Array<{ customType: string; content: string; options?: SendMessageOptions }> = [];
	const cancelledMessages: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const eventBus = createEventBus();
	const theme = {
		fg: (_slot: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const pi = {
		appendEntry(customType: string, data?: unknown) {
			entries.push({
				type: "custom",
				id: `entry-${entries.length + 1}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
		sendMessage(message: { customType: string; content: string }, options?: SendMessageOptions) {
			messages.push({ ...message, options });
		},
		cancelMessage(key: string) {
			cancelledMessages.push(key);
		},
		getActiveTools: () => [],
		events: eventBus,
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		ui: {
			setWidget() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			theme,
		},
		sessionManager: {
			getBranch: () => [...entries],
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, entries, messages, cancelledMessages, notifications, eventBus };
}

function bindingEntry(environment: FakeEnvironment, index = -1): TodoBindingEntry {
	const entries = environment.entries.filter(
		(entry) => entry.type === "custom" && entry.customType === TODO_BINDING_ENTRY,
	);
	const entry = index < 0 ? entries.at(index) : entries[index];
	if (entry?.type !== "custom") throw new Error("Missing binding entry");
	return entry.data as TodoBindingEntry;
}

function branchWithBinding(binding: TodoBindingEntry): SessionEntry[] {
	return [
		{
			type: "custom",
			id: "binding",
			parentId: null,
			timestamp: binding.timestamp,
			customType: TODO_BINDING_ENTRY,
			data: binding,
		},
	];
}

describe("TodoRuntime recovery", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "pi-todo-runtime-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("restores resume/reload state, isolates forks, and restores historical tree state", async () => {
		const original = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(original.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, original.ctx);
		await runtime.replace("Ship", [{ id: "A", subject: "Task A", depends_on: [] }]);
		const initialBinding = bindingEntry(original);
		await runtime.claim("A");
		await runtime.add([
			{ id: "B", subject: "Task B", depends_on: ["A"] },
			{ id: "C", subject: "Task C", depends_on: [] },
		]);
		await runtime.claim("C");
		await runtime.transfer("C", "agent-orphan");
		const currentBinding = bindingEntry(original);

		const resumedEnvironment = fakeEnvironment("session-1", branchWithBinding(currentBinding));
		const resumed = new TodoRuntime(resumedEnvironment.pi, { dataDir });
		await resumed.initialize(
			{ type: "session_start", reason: "resume", previousSessionFile: "old.jsonl" },
			resumedEnvironment.ctx,
		);
		await resumed.reconcileOwners();
		expect((await resumed.getTask("A"))?.status).toBe("in_progress");
		expect((await resumed.getTask("B"))?.depends_on).toEqual(["A"]);
		expect((await resumed.getTask("C"))?.status).toBe("pending");
		expect((await resumed.getTask("C"))?.owner).toBeUndefined();

		const forkEnvironment = fakeEnvironment("session-2", branchWithBinding(currentBinding));
		const fork = new TodoRuntime(forkEnvironment.pi, { dataDir });
		await fork.initialize(
			{ type: "session_start", reason: "fork", previousSessionFile: "old.jsonl" },
			forkEnvironment.ctx,
		);
		expect(fork.getListId()).not.toBe(runtime.getListId());
		const forkedTask = await fork.getTask("A");
		expect(forkedTask?.status).toBe("pending");
		expect(forkedTask?.owner).toBeUndefined();

		const historicalEnvironment = fakeEnvironment("session-1", branchWithBinding(initialBinding));
		await runtime.restoreTree(historicalEnvironment.ctx);
		expect(runtime.getListId()).not.toBe(initialBinding.list_id);
		expect((await runtime.view())?.list.tasks.map((task) => task.id)).toEqual(["A"]);

		const newEnvironment = fakeEnvironment("session-new", branchWithBinding(currentBinding));
		const fresh = new TodoRuntime(newEnvironment.pi, { dataDir });
		await fresh.initialize(
			{ type: "session_start", reason: "new", previousSessionFile: "old.jsonl" },
			newEnvironment.ctx,
		);
		expect(await fresh.view()).toBeUndefined();
	});

	it("re-injects a compact active digest without relying on the widget", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace(
			"Resume after compact ".repeat(100),
			Array.from({ length: 8 }, (_, index) => ({
				id: `T${index}`,
				subject: `Keep working ${index}`,
				depends_on: [],
			})),
		);
		await runtime.injectDigest();
		expect(environment.messages[0]).toMatchObject({
			customType: "pi-todo-digest",
			content: expect.stringContaining("Ready: T0"),
		});
		expect(environment.messages[0]?.content).toContain("Snapshot: list ");
		expect(environment.messages[0]?.content).toContain("... 3 more");
		expect(environment.messages[0]?.content.length).toBeLessThanOrEqual(4000);
	});

	it("resolves queued digests from live state and cancels them after completion", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Ship", [{ id: "A", subject: "Task A", depends_on: [] }]);
		const listId = runtime.getListId();
		await runtime.injectDigest("followUp");
		const queued = environment.messages[0];
		const resolver = queued?.options?.queue?.resolve;
		if (!resolver) throw new Error("Missing live digest resolver");

		await runtime.add([{ id: "B", subject: "Task B", depends_on: [] }]);
		const latest = await resolver(new AbortController().signal);
		expect(latest?.content).toContain("Ready: A: Task A; B: Task B");

		await runtime.claim("A");
		await runtime.update("A", { status: "completed" });
		await runtime.claim("B");
		await runtime.update("B", { status: "completed" });
		expect(await resolver(new AbortController().signal)).toBeUndefined();
		expect(environment.cancelledMessages).toContain(`pi-todo:session-1:${listId}`);
		for (let turn = 0; turn < 20; turn++) await runtime.onTurnEnd();
		expect(environment.messages).toHaveLength(1);
	});

	it("only schedules periodic digests while a list is active", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Ship", [{ id: "A", subject: "Task A", depends_on: [] }]);

		for (let turn = 0; turn < 9; turn++) await runtime.onTurnEnd();
		expect(environment.messages).toHaveLength(0);
		await runtime.onTurnEnd();
		expect(environment.messages).toHaveLength(1);

		await runtime.claim("A");
		await runtime.update("A", { status: "completed" });
		for (let turn = 0; turn < 20; turn++) await runtime.onTurnEnd();
		expect(environment.messages).toHaveLength(1);
	});

	it("auto-clears the list once every task is completed and still returns the final document", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Ship", [
			{ id: "A", subject: "Task A", depends_on: [] },
			{ id: "B", subject: "Task B", depends_on: [] },
		]);
		const listId = runtime.getListId();
		if (!listId) throw new Error("Missing list id");

		await runtime.claim("A");
		const partial = await runtime.update("A", { status: "completed" });
		expect(partial.tasks.some((task) => task.status !== "completed")).toBe(true);
		expect(runtime.getListId()).toBe(listId);

		await runtime.claim("B");
		const final = await runtime.update("B", { status: "completed" });
		expect(final.tasks.map((task) => task.id)).toEqual(["A", "B"]);
		expect(final.tasks.every((task) => task.status === "completed")).toBe(true);
		expect(runtime.getListId()).toBeUndefined();
		expect(await runtime.view()).toBeUndefined();
		expect(bindingEntry(environment).list_id).toBeNull();
		await expect(runtime.store.read(listId)).rejects.toThrow("does not exist");
	});

	it("unbinds when the bound list disappears from disk and treats it as inactive", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Ship", [{ id: "A", subject: "Task A", depends_on: [] }]);
		const listId = runtime.getListId();
		if (!listId) throw new Error("Missing list id");

		// Another session cleared the list: its directory is gone while this
		// session still holds a binding to it.
		await rm(join(dataDir, listId), { recursive: true, force: true });

		expect(await runtime.view()).toBeUndefined();
		expect(await runtime.digest()).toBeUndefined();
		expect(runtime.getListId()).toBeUndefined();
		expect(bindingEntry(environment)).toMatchObject({ version: 1, list_id: null, revision: 0 });
		expect(environment.notifications.at(-1)?.message).toContain(`Todo list "${listId}" does not exist`);
		expect(environment.notifications.at(-1)?.level).toBe("warning");
		for (let turn = 0; turn < 20; turn++) await runtime.onTurnEnd();
		expect(environment.messages).toHaveLength(0);
	});

	it("self-heals a stale binding whose list no longer exists on resume", async () => {
		const stale: TodoBindingEntry = {
			version: 1,
			list_id: "missing-list",
			revision: 1,
			timestamp: new Date().toISOString(),
		};
		const environment = fakeEnvironment("session-1", branchWithBinding(stale));
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await expect(
			runtime.initialize(
				{ type: "session_start", reason: "resume", previousSessionFile: "old.jsonl" },
				environment.ctx,
			),
		).resolves.toBeUndefined();
		expect(runtime.getListId()).toBeUndefined();
		expect(bindingEntry(environment)).toMatchObject({ version: 1, list_id: null, revision: 0 });
		expect(await runtime.view()).toBeUndefined();
	});

	it("self-heals restoreTree and fork when the bound list no longer exists", async () => {
		const stale: TodoBindingEntry = {
			version: 1,
			list_id: "missing-list",
			revision: 1,
			timestamp: new Date().toISOString(),
		};

		const restoredEnvironment = fakeEnvironment("session-1", branchWithBinding(stale));
		const restored = new TodoRuntime(restoredEnvironment.pi, { dataDir });
		await expect(restored.restoreTree(restoredEnvironment.ctx)).resolves.toBeUndefined();
		expect(restored.getListId()).toBeUndefined();
		expect(bindingEntry(restoredEnvironment).list_id).toBeNull();

		const forkEnvironment = fakeEnvironment("session-2", branchWithBinding(stale));
		const fork = new TodoRuntime(forkEnvironment.pi, { dataDir });
		await expect(
			fork.initialize(
				{ type: "session_start", reason: "fork", previousSessionFile: "old.jsonl" },
				forkEnvironment.ctx,
			),
		).resolves.toBeUndefined();
		expect(fork.getListId()).toBeUndefined();
		expect(bindingEntry(forkEnvironment).list_id).toBeNull();
	});

	it("keeps the binding when the list is corrupt but still present", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Ship", [{ id: "A", subject: "Task A", depends_on: [] }]);
		const listId = runtime.getListId();
		if (!listId) throw new Error("Missing list id");

		await writeFile(join(dataDir, listId, "tasks.json"), "{ not valid json", "utf8");
		expect(runtime.getListId()).toBe(listId);
		await expect(runtime.view()).rejects.toThrow("corrupt");
		expect(runtime.getListId()).toBe(listId);
		expect(bindingEntry(environment).list_id).toBe(listId);
	});

	it("resolves queued digests to undefined when the list disappears", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Ship", [{ id: "A", subject: "Task A", depends_on: [] }]);
		const listId = runtime.getListId();
		if (!listId) throw new Error("Missing list id");
		await runtime.injectDigest("followUp");
		const resolver = environment.messages[0]?.options?.queue?.resolve;
		if (!resolver) throw new Error("Missing live digest resolver");

		await rm(join(dataDir, listId), { recursive: true, force: true });
		expect(await resolver(new AbortController().signal)).toBeUndefined();
		expect(runtime.getListId()).toBeUndefined();
		expect(bindingEntry(environment).list_id).toBeNull();
	});

	it("preserves a live external owner when it re-announces matching claim evidence", async () => {
		const original = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(original.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, original.ctx);
		await runtime.replace("Delegate", [{ id: "A", subject: "Agent task", depends_on: [] }]);
		await runtime.claim("A");
		await runtime.transfer("A", "agent-live");
		const binding = bindingEntry(original);

		const resumedEnvironment = fakeEnvironment("session-1", branchWithBinding(binding));
		const resumed = new TodoRuntime(resumedEnvironment.pi, { dataDir });
		const disposeProtocol = registerAgentLifecycleProtocol(resumedEnvironment.eventBus, resumed);
		const disposeResponder = resumedEnvironment.eventBus.on("pi:agent:status-request", () => {
			resumedEnvironment.eventBus.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 2,
				eventId: "running-after-resume",
				runId: "run-after-resume",
				agentId: "agent-live",
				parentSessionId: "session-1",
				status: "running",
				timestamp: new Date().toISOString(),
				metadata: {
					"pi.todo/list-id": binding.list_id,
					"pi.todo/task-id": "A",
				},
			});
		});
		try {
			await resumed.initialize({ type: "session_start", reason: "resume" }, resumedEnvironment.ctx);
			await resumed.reconcileOwners();
			expect(await resumed.getTask("A")).toMatchObject({ status: "in_progress", owner: "agent-live" });
		} finally {
			disposeResponder();
			disposeProtocol();
		}
	});

	it("recovers live owners after session_start in either extension loading order", async () => {
		for (const order of ["todo-first", "agent-first"] as const) {
			const original = fakeEnvironment(`session-${order}`);
			const runtime = new TodoRuntime(original.pi, { dataDir });
			await runtime.initialize({ type: "session_start", reason: "startup" }, original.ctx);
			await runtime.replace(order, [{ id: "A", subject: "Agent task", depends_on: [] }]);
			await runtime.claim("A");
			await runtime.transfer("A", `agent-${order}`);
			const binding = bindingEntry(original);

			const resumedEnvironment = fakeEnvironment(`session-${order}`, branchWithBinding(binding));
			const resumed = new TodoRuntime(resumedEnvironment.pi, { dataDir });
			let managerReady = order === "agent-first";
			const disposeProtocol = registerAgentLifecycleProtocol(resumedEnvironment.eventBus, resumed);
			const disposeResponder = resumedEnvironment.eventBus.on("pi:agent:status-request", () => {
				if (!managerReady) return;
				resumedEnvironment.eventBus.emit(AGENT_LIFECYCLE_CHANNEL, {
					version: 2,
					eventId: `running-${order}`,
					runId: `run-${order}`,
					agentId: `agent-${order}`,
					parentSessionId: `session-${order}`,
					status: "running",
					timestamp: new Date().toISOString(),
					metadata: {
						"pi.todo/list-id": binding.list_id,
						"pi.todo/task-id": "A",
					},
				});
			});
			try {
				await resumed.initialize({ type: "session_start", reason: "resume" }, resumedEnvironment.ctx);
				managerReady = true;
				await resumed.reconcileOwners();
				expect(await resumed.getTask("A")).toMatchObject({
					status: "in_progress",
					owner: `agent-${order}`,
				});
			} finally {
				disposeResponder();
				disposeProtocol();
			}
		}
	});

	it("syncs explicit child completion into the parent binding and releases failures", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Delegate", [
			{ id: "A", subject: "Agent task", depends_on: [] },
			{ id: "B", subject: "Failing agent task", depends_on: [] },
		]);
		await runtime.claim("A");
		const metadata = {
			"pi.todo/list-id": runtime.getListId(),
			"pi.todo/task-id": "A",
		};
		const events = environment.eventBus;
		const dispose = registerAgentLifecycleProtocol(events, runtime);
		try {
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 2,
				eventId: "queued-1",
				runId: "run-1",
				agentId: "agent-1",
				parentSessionId: "session-1",
				status: "queued",
				timestamp: new Date().toISOString(),
				metadata,
			});
			await vi.waitFor(async () => expect(await runtime.getTask("A")).toMatchObject({ owner: "agent-1" }), {
				timeout: 5000,
			});
			await runtime.store.update(runtime.getListId() ?? "", "A", { status: "completed" });
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 2,
				eventId: "complete-1",
				runId: "run-1",
				agentId: "agent-1",
				parentSessionId: "session-1",
				status: "completed",
				timestamp: new Date().toISOString(),
				metadata,
			});
			await vi.waitFor(async () => expect((await runtime.getTask("A"))?.status).toBe("completed"), {
				timeout: 5000,
			});
			await vi.waitFor(
				async () => expect(bindingEntry(environment).revision).toBe((await runtime.view())?.list.revision),
				{ timeout: 5000 },
			);
			const completedBinding = bindingEntry(environment);

			const forkEnvironment = fakeEnvironment("session-fork", branchWithBinding(completedBinding));
			const fork = new TodoRuntime(forkEnvironment.pi, { dataDir });
			await fork.initialize({ type: "session_start", reason: "fork" }, forkEnvironment.ctx);
			expect((await fork.getTask("A"))?.status).toBe("completed");

			await runtime.claim("B");
			const failedMetadata = {
				"pi.todo/list-id": runtime.getListId(),
				"pi.todo/task-id": "B",
			};
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 2,
				eventId: "queued-2",
				runId: "run-2",
				agentId: "agent-2",
				parentSessionId: "session-1",
				status: "queued",
				timestamp: new Date().toISOString(),
				metadata: failedMetadata,
			});
			await vi.waitFor(async () => expect(await runtime.getTask("B")).toMatchObject({ owner: "agent-2" }), {
				timeout: 5000,
			});
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 2,
				eventId: "failed-1",
				runId: "run-2",
				agentId: "agent-2",
				parentSessionId: "session-1",
				status: "failed",
				timestamp: new Date().toISOString(),
				metadata: failedMetadata,
			});
			await vi.waitFor(async () => expect((await runtime.getTask("B"))?.status).toBe("pending"), { timeout: 5000 });
		} finally {
			dispose();
			events.clear();
		}
	});

	it("serializes lifecycle events and ignores stale active or failure events", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("Race", [
			{ id: "A", subject: "Late active", depends_on: [] },
			{ id: "B", subject: "Changed owner", depends_on: [] },
			{ id: "C", subject: "Old protocol", depends_on: [] },
		]);
		const events = environment.eventBus;
		const dispose = registerAgentLifecycleProtocol(events, runtime);
		try {
			for (const id of ["A", "B"] as const) {
				await runtime.claim(id);
				const metadata = {
					"pi.todo/list-id": runtime.getListId(),
					"pi.todo/task-id": id,
				};
				const active = {
					version: 2,
					eventId: `${id}-running`,
					runId: `${id}-run`,
					agentId: `agent-${id}`,
					parentSessionId: "session-1",
					status: "running",
					timestamp: new Date().toISOString(),
					metadata,
				};
				const terminal = { ...active, eventId: `${id}-failed`, status: "failed" };
				events.emit(AGENT_LIFECYCLE_CHANNEL, active);
				await vi.waitFor(async () => expect((await runtime.getTask(id))?.owner).toBe(`agent-${id}`), {
					timeout: 5000,
				});
				if (id === "B") await runtime.transfer(id, "replacement-agent");
				events.emit(AGENT_LIFECYCLE_CHANNEL, terminal);
				if (id === "A") {
					await vi.waitFor(async () => expect((await runtime.getTask(id))?.status).toBe("pending"), {
						timeout: 5000,
					});
					events.emit(AGENT_LIFECYCLE_CHANNEL, { ...active, eventId: `${id}-late-running` });
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect((await runtime.getTask(id))?.status).toBe("pending");
				} else {
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(await runtime.getTask(id)).toMatchObject({
						status: "in_progress",
						owner: "replacement-agent",
					});
				}
			}

			await runtime.claim("C");
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 1,
				eventId: "old-version",
				agentId: "agent-C",
				parentSessionId: "session-1",
				status: "running",
				timestamp: new Date().toISOString(),
				metadata: {
					"pi.todo/list-id": runtime.getListId(),
					"pi.todo/task-id": "C",
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect((await runtime.getTask("C"))?.owner).not.toBe("agent-C");
		} finally {
			dispose();
			events.clear();
		}
	});

	it("renders bounded independent UI sections in narrow terminals", async () => {
		const environment = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(environment.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, environment.ctx);
		await runtime.replace("UI", [
			{ id: "A", subject: "A very long active task name", active_form: "Actively implementing", depends_on: [] },
			{ id: "B", subject: "A blocked task", depends_on: ["A"] },
		]);
		await runtime.claim("A", "owner-with-a-long-name");
		const view = await runtime.view();
		if (!view) throw new Error("Missing view");
		const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text } as Theme;
		const lines = renderTodoLines(view, theme, 24);
		expect(lines.some((line) => line.includes("Active (1)"))).toBe(true);
		expect(lines.some((line) => line.includes("Actively"))).toBe(true);
		expect(lines.some((line) => line.includes("Blocked (1)"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});
});
