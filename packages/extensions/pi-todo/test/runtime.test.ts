import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@handy_wote/pi-coding-agent";
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
	messages: Array<{ customType: string; content: string }>;
	eventBus: ReturnType<typeof createEventBus>;
}

function fakeEnvironment(sessionId: string, initialEntries: SessionEntry[] = []): FakeEnvironment {
	const entries = [...initialEntries];
	const messages: Array<{ customType: string; content: string }> = [];
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
		sendMessage(message: { customType: string; content: string }) {
			messages.push(message);
		},
		getActiveTools: () => [],
		events: eventBus,
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		ui: { setWidget() {}, notify() {}, theme },
		sessionManager: {
			getBranch: () => [...entries],
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, entries, messages, eventBus };
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
		const external = await runtime.claim("C");
		await runtime.transfer("C", "agent-orphan", external.claim_token);
		const currentBinding = bindingEntry(original);

		const resumedEnvironment = fakeEnvironment("session-1", branchWithBinding(currentBinding));
		const resumed = new TodoRuntime(resumedEnvironment.pi, { dataDir });
		await resumed.initialize(
			{ type: "session_start", reason: "resume", previousSessionFile: "old.jsonl" },
			resumedEnvironment.ctx,
		);
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
		expect(environment.messages[0]?.content).toContain("... 3 more");
		expect(environment.messages[0]?.content.length).toBeLessThanOrEqual(4000);
	});

	it("preserves a live external owner when it re-announces matching claim evidence", async () => {
		const original = fakeEnvironment("session-1");
		const runtime = new TodoRuntime(original.pi, { dataDir });
		await runtime.initialize({ type: "session_start", reason: "startup" }, original.ctx);
		await runtime.replace("Delegate", [{ id: "A", subject: "Agent task", depends_on: [] }]);
		const claim = await runtime.claim("A");
		await runtime.transfer("A", "agent-live", claim.claim_token);
		const binding = bindingEntry(original);

		const resumedEnvironment = fakeEnvironment("session-1", branchWithBinding(binding));
		const resumed = new TodoRuntime(resumedEnvironment.pi, { dataDir });
		const disposeProtocol = registerAgentLifecycleProtocol(resumedEnvironment.eventBus, resumed);
		const disposeResponder = resumedEnvironment.eventBus.on("pi:agent:status-request", () => {
			resumedEnvironment.eventBus.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 1,
				eventId: "running-after-resume",
				agentId: "agent-live",
				parentSessionId: "session-1",
				status: "running",
				timestamp: new Date().toISOString(),
				metadata: {
					"pi.todo/list-id": binding.list_id,
					"pi.todo/task-id": "A",
					"pi.todo/claim-token": claim.claim_token,
				},
			});
		});
		try {
			await resumed.initialize({ type: "session_start", reason: "resume" }, resumedEnvironment.ctx);
			expect(await resumed.getTask("A")).toMatchObject({ status: "in_progress", owner: "agent-live" });
		} finally {
			disposeResponder();
			disposeProtocol();
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
		const claim = await runtime.claim("A");
		const metadata = {
			"pi.todo/list-id": runtime.getListId(),
			"pi.todo/task-id": "A",
			"pi.todo/claim-token": claim.claim_token,
		};
		const events = environment.eventBus;
		const dispose = registerAgentLifecycleProtocol(events, runtime);
		try {
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 1,
				eventId: "queued-1",
				agentId: "agent-1",
				parentSessionId: "session-1",
				status: "queued",
				timestamp: new Date().toISOString(),
				metadata,
			});
			await vi.waitFor(async () => expect(await runtime.getTask("A")).toMatchObject({ owner: "agent-1" }), {
				timeout: 5000,
			});
			await runtime.store.update(runtime.getListId() ?? "", "A", {
				status: "completed",
				claim_token: claim.claim_token,
			});
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 1,
				eventId: "complete-1",
				agentId: "agent-1",
				parentSessionId: "session-1",
				status: "completed",
				timestamp: new Date().toISOString(),
				metadata,
			});
			await vi.waitFor(async () => expect((await runtime.getTask("A"))?.status).toBe("completed"), {
				timeout: 5000,
			});
			const completedBinding = bindingEntry(environment);
			expect(completedBinding.revision).toBe((await runtime.view())?.list.revision);

			const forkEnvironment = fakeEnvironment("session-fork", branchWithBinding(completedBinding));
			const fork = new TodoRuntime(forkEnvironment.pi, { dataDir });
			await fork.initialize({ type: "session_start", reason: "fork" }, forkEnvironment.ctx);
			expect((await fork.getTask("A"))?.status).toBe("completed");

			const failedClaim = await runtime.claim("B");
			const failedMetadata = {
				"pi.todo/list-id": runtime.getListId(),
				"pi.todo/task-id": "B",
				"pi.todo/claim-token": failedClaim.claim_token,
			};
			events.emit(AGENT_LIFECYCLE_CHANNEL, {
				version: 1,
				eventId: "queued-2",
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
				version: 1,
				eventId: "failed-1",
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
