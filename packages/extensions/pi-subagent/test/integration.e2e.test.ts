import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "@handy_wote/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import piTodo from "../../pi-todo/src/index.ts";
import { AGENT_STATUS_REQUEST_CHANNEL } from "../../pi-todo/src/runtime.ts";
import type { TodoTask } from "../../pi-todo/src/types.ts";
import { createPiSubagent } from "../src/index.ts";
import { AgentManager } from "../src/manager.ts";
import type { AgentToolDetails } from "../src/render.ts";
import { AGENT_PROTOCOL_CHANNEL, type AgentLifecycleEvent } from "../src/types.ts";

const fakePiPath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
const harnesses: Harness[] = [];
const extraRoots: string[] = [];
const originalAgentContext = process.env.PI_AGENT_CONTEXT;
const originalCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

type TodoExtensionAPI = Parameters<typeof piTodo>[0];

interface ClaimDetails {
	task: TodoTask;
	metadata: Record<string, string>;
}

afterEach(async () => {
	restoreEnvironment("PI_CODING_AGENT_DIR", originalCodingAgentDir);
	restoreEnvironment("PI_AGENT_CONTEXT", originalAgentContext);
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await new Promise((resolve) => setTimeout(resolve, 100));
	for (const root of extraRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	extraRoots.push(root);
	return root;
}

function restoreEnvironment(name: "PI_AGENT_CONTEXT" | "PI_CODING_AGENT_DIR", value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function installUserAgent(harness: Harness): void {
	process.env.PI_CODING_AGENT_DIR = path.join(harness.tempDir, "agent-home");
	const directory = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "worker.md"),
		"---\nname: worker\ndescription: Integration worker\n---\nComplete delegated work.\n",
	);
}

function requireTool(harness: Harness, name: string) {
	const tool = harness.session.state.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Tool ${name} is not active`);
	return tool;
}

async function getTask(harness: Harness, id: string): Promise<TodoTask> {
	const result = await requireTool(harness, "todo_get").execute(`get-${id}`, { id });
	return result.details as TodoTask;
}

async function waitForTask(harness: Harness, id: string, expected: Partial<TodoTask>): Promise<void> {
	await vi.waitFor(
		async () => {
			expect(await getTask(harness, id)).toMatchObject(expected);
		},
		{ timeout: 5000, interval: 10 },
	);
}

async function waitForReleasedTask(harness: Harness, id: string): Promise<void> {
	await vi.waitFor(
		async () => {
			const task = await getTask(harness, id);
			expect(task.status).toBe("pending");
			expect(task.owner).toBeUndefined();
		},
		{ timeout: 5000, interval: 10 },
	);
}

async function waitForAgent(manager: AgentManager, agentId: string, status: string): Promise<void> {
	await vi.waitFor(() => expect(manager.get(agentId)?.status).toBe(status), { timeout: 5000, interval: 10 });
}

async function createCombinedHarness(taskIds: readonly string[]) {
	const todoRoot = temporaryRoot("pi-combined-todo-");
	const subagentRoot = temporaryRoot("pi-combined-subagent-");
	const managers: AgentManager[] = [];
	let events: EventBus | undefined;
	const harness = await createHarness({
		extensionFactories: [
			{
				name: "pi-todo",
				factory: (pi) => {
					events = pi.events;
					piTodo(pi as unknown as TodoExtensionAPI, { dataDir: todoRoot });
				},
			},
			{
				name: "pi-subagent",
				factory: createPiSubagent({
					createManager: (options) => {
						const manager = new AgentManager({
							...options,
							rootDir: subagentRoot,
							invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
							killGraceMs: 40,
						});
						managers.push(manager);
						return manager;
					},
				}),
			},
		],
	});
	harnesses.push(harness);
	installUserAgent(harness);
	await harness.session.bindExtensions({
		uiContext: harness.session.extensionRunner.getUIContext(),
		mode: "tui",
	});
	await requireTool(harness, "write_todo").execute("write", {
		global_direction: "Exercise Todo and Subagent together",
		items: taskIds.map((id) => ({ id, subject: `Task ${id}`, depends_on: [] })),
	});
	if (!events || !managers[0]) throw new Error("Combined extensions did not initialize");
	return { harness, events, managers, todoRoot };
}

async function createAgentTodoHarness(
	todoRoot: string,
	agentId: string,
	runId: string,
	parentSessionId: string,
	metadata: Record<string, string>,
): Promise<Harness> {
	const previousAgentContext = process.env.PI_AGENT_CONTEXT;
	process.env.PI_AGENT_CONTEXT = JSON.stringify({ version: 2, agentId, runId, parentSessionId, metadata });
	let harness: Harness;
	try {
		harness = await createHarness({
			extensionFactories: [
				{
					name: "pi-todo",
					factory: (pi) => piTodo(pi as unknown as TodoExtensionAPI, { dataDir: todoRoot }),
				},
			],
		});
	} finally {
		restoreEnvironment("PI_AGENT_CONTEXT", previousAgentContext);
	}
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

async function claim(harness: Harness, id: string): Promise<ClaimDetails> {
	const result = await requireTool(harness, "todo_claim").execute(`claim-${id}`, { id });
	return result.details as ClaimDetails;
}

async function startAgent(harness: Harness, task: string, metadata: Record<string, string>) {
	const result = await requireTool(harness, "agent_start").execute(`start-${task}`, {
		agent: "worker",
		task,
		mode: "background",
		scope: "user",
		metadata,
	});
	const details = result.details as AgentToolDetails;
	const record = details.records[0];
	if (!record) throw new Error("Agent did not start");
	return record;
}

function lifecycleEvent(
	base: AgentLifecycleEvent,
	status: AgentLifecycleEvent["status"],
	eventId: string,
	agentId = base.agentId,
): AgentLifecycleEvent {
	return { ...base, status, eventId, agentId, timestamp: new Date().toISOString() };
}

describe("pi-todo and pi-subagent integration", () => {
	it("passes claim metadata to Agent, transfers queued/running ownership, and requires explicit Todo completion", async () => {
		const { harness, events, managers, todoRoot } = await createCombinedHarness(["A", "B"]);
		const observed: AgentLifecycleEvent[] = [];
		const dispose = events.on(AGENT_PROTOCOL_CHANNEL, (value) => {
			if (typeof value === "object" && value !== null && "status" in value)
				observed.push(value as AgentLifecycleEvent);
		});
		try {
			const completedClaim = await claim(harness, "A");
			expect(Object.keys(completedClaim.metadata).sort()).toEqual(["pi.todo/list-id", "pi.todo/task-id"]);
			const completedAgent = await startAgent(harness, "delay:150 explicit-completion", completedClaim.metadata);
			expect(completedAgent.metadata).toEqual(completedClaim.metadata);
			await waitForTask(harness, "A", { status: "in_progress", owner: completedAgent.agentId });
			const childTodoHarness = await createAgentTodoHarness(
				todoRoot,
				completedAgent.agentId,
				completedAgent.runId,
				completedAgent.parentSessionId,
				completedAgent.metadata,
			);
			await requireTool(childTodoHarness, "todo_update").execute("complete-A", {
				id: "A",
				status: "completed",
			});
			await waitForAgent(managers[0]!, completedAgent.agentId, "completed");
			await waitForTask(harness, "A", { status: "completed" });
			expect((await getTask(harness, "A")).owner).toBeUndefined();

			const unfinishedClaim = await claim(harness, "B");
			const unfinishedAgent = await startAgent(harness, "delay:20 no-todo-update", unfinishedClaim.metadata);
			await waitForAgent(managers[0]!, unfinishedAgent.agentId, "completed");
			await waitForTask(harness, "B", { status: "in_progress", owner: unfinishedAgent.agentId });
			expect(
				observed.filter((event) => event.agentId === completedAgent.agentId).map((event) => event.status),
			).toEqual(expect.arrayContaining(["queued", "running", "completed"]));
			expect(
				observed.filter((event) => event.agentId === unfinishedAgent.agentId).map((event) => event.status),
			).toEqual(expect.arrayContaining(["queued", "running", "completed"]));
		} finally {
			dispose();
		}
	});

	it("releases failed, stopped, and interrupted claims and ignores stale lifecycle runs", async () => {
		const { harness, events, managers } = await createCombinedHarness(["F", "S", "I"]);
		const terminalEvents: AgentLifecycleEvent[] = [];
		const dispose = events.on(AGENT_PROTOCOL_CHANNEL, (value) => {
			if (typeof value !== "object" || value === null || !("status" in value)) return;
			const event = value as AgentLifecycleEvent;
			if (["failed", "stopped", "interrupted"].includes(event.status)) terminalEvents.push(event);
		});
		try {
			const failedClaim = await claim(harness, "F");
			const failedAgent = await startAgent(harness, "fail delay:20", failedClaim.metadata);
			await waitForAgent(managers[0]!, failedAgent.agentId, "failed");
			await waitForReleasedTask(harness, "F");

			const replacementClaim = await claim(harness, "F");
			const resumeResult = await requireTool(harness, "agent_resume").execute("resume-F", {
				agentId: failedAgent.agentId,
				prompt: "ignore-term delay:10000",
				mode: "background",
			});
			const replacementAgent = (resumeResult.details as AgentToolDetails).records[0];
			if (!replacementAgent) throw new Error("Agent did not resume");
			expect(replacementAgent.agentId).toBe(failedAgent.agentId);
			expect(replacementAgent.runId).not.toBe(failedAgent.runId);
			expect(replacementAgent.metadata).toEqual(replacementClaim.metadata);
			await waitForAgent(managers[0]!, replacementAgent.agentId, "running");
			await waitForTask(harness, "F", { status: "in_progress", owner: replacementAgent.agentId });
			const failedEvent = terminalEvents.find((event) => event.agentId === failedAgent.agentId);
			if (!failedEvent) throw new Error("Missing failed lifecycle event");
			events.emit(AGENT_PROTOCOL_CHANNEL, lifecycleEvent(failedEvent, "running", "stale-running"));
			events.emit(AGENT_PROTOCOL_CHANNEL, lifecycleEvent(failedEvent, "failed", "stale-failed"));
			await new Promise((resolve) => setTimeout(resolve, 20));
			await waitForTask(harness, "F", { status: "in_progress", owner: replacementAgent.agentId });
			await requireTool(harness, "agent_stop").execute("stop-F", { agentId: replacementAgent.agentId });
			await waitForReleasedTask(harness, "F");

			const stoppedClaim = await claim(harness, "S");
			const stoppedAgent = await startAgent(harness, "ignore-term delay:10000", stoppedClaim.metadata);
			await waitForAgent(managers[0]!, stoppedAgent.agentId, "running");
			await requireTool(harness, "agent_stop").execute("stop-S", { agentId: stoppedAgent.agentId });
			await waitForReleasedTask(harness, "S");
			const stoppedEvent = terminalEvents.find((event) => event.agentId === stoppedAgent.agentId);
			if (!stoppedEvent) throw new Error("Missing stopped lifecycle event");
			events.emit(AGENT_PROTOCOL_CHANNEL, lifecycleEvent(stoppedEvent, "running", "late-running-after-stop"));
			await new Promise((resolve) => setTimeout(resolve, 20));
			await waitForReleasedTask(harness, "S");

			const interruptedClaim = await claim(harness, "I");
			const interruptedAgent = await startAgent(harness, "ignore-term delay:10000", interruptedClaim.metadata);
			await waitForAgent(managers[0]!, interruptedAgent.agentId, "running");
			await managers[0]!.shutdown();
			await waitForReleasedTask(harness, "I");
			expect(terminalEvents).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ agentId: failedAgent.agentId, status: "failed" }),
					expect.objectContaining({ agentId: stoppedAgent.agentId, status: "stopped" }),
					expect.objectContaining({ agentId: interruptedAgent.agentId, status: "interrupted" }),
				]),
			);
		} finally {
			dispose();
		}
	});

	it("replays active status on request and restores a safe pending task after reload", async () => {
		const { harness, events, managers } = await createCombinedHarness(["R"]);
		const observed: AgentLifecycleEvent[] = [];
		const dispose = events.on(AGENT_PROTOCOL_CHANNEL, (value) => {
			if (typeof value === "object" && value !== null && "status" in value)
				observed.push(value as AgentLifecycleEvent);
		});
		const activeClaim = await claim(harness, "R");
		const execution = requireTool(harness, "agent_start").execute("start-R", {
			agent: "worker",
			task: "ignore-term delay:10000",
			mode: "foreground",
			scope: "user",
			metadata: activeClaim.metadata,
		});
		await vi.waitFor(() => expect(managers[0]!.list()).toHaveLength(1), { timeout: 5000 });
		const agentId = managers[0]!.list()[0]!.agentId;
		await waitForAgent(managers[0]!, agentId, "running");
		await waitForTask(harness, "R", { status: "in_progress", owner: agentId });

		const running = managers[0]!.get(agentId);
		if (!running) throw new Error("Missing running agent");
		const beforeReplay = observed.filter((event) => event.eventId === running.lifecycleEventId).length;
		events.emit(AGENT_STATUS_REQUEST_CHANNEL, {
			version: 2,
			parentSessionId: running.parentSessionId,
			timestamp: new Date().toISOString(),
		});
		await vi.waitFor(
			() =>
				expect(observed.filter((event) => event.eventId === running.lifecycleEventId).length).toBeGreaterThan(
					beforeReplay,
				),
			{ timeout: 5000 },
		);
		expect(observed.at(-1)).toMatchObject({
			agentId,
			runId: running.runId,
			status: "running",
			metadata: activeClaim.metadata,
		});

		await harness.session.reload();
		await execution;
		expect(managers).toHaveLength(2);
		expect(managers[1]!.get(agentId)).toMatchObject({ status: "interrupted" });
		await harness.session.prompt("/todo list");
		await waitForReleasedTask(harness, "R");
		dispose();
	});

	it("keeps each plugin fully usable when the other plugin is absent", async () => {
		const todoRoot = temporaryRoot("pi-standalone-todo-");
		const todoHarness = await createHarness({
			extensionFactories: [
				{
					name: "pi-todo",
					factory: (pi) => piTodo(pi as unknown as TodoExtensionAPI, { dataDir: todoRoot }),
				},
			],
		});
		harnesses.push(todoHarness);
		await todoHarness.session.bindExtensions({});
		expect(todoHarness.session.state.tools.some((tool) => tool.name === "agent_start")).toBe(false);
		await requireTool(todoHarness, "write_todo").execute("todo-only", {
			global_direction: "Standalone Todo",
			items: [{ id: "T", subject: "Todo only", depends_on: [] }],
		});
		expect(getMessageText(await requireTool(todoHarness, "todo_list").execute("list", {}))).toContain("1 ready");

		const subagentRoot = temporaryRoot("pi-standalone-subagent-");
		let manager: AgentManager | undefined;
		const subagentHarness = await createHarness({
			extensionFactories: [
				{
					name: "pi-subagent",
					factory: createPiSubagent({
						createManager: (options) => {
							manager = new AgentManager({
								...options,
								rootDir: subagentRoot,
								invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
							});
							return manager;
						},
					}),
				},
			],
		});
		harnesses.push(subagentHarness);
		installUserAgent(subagentHarness);
		await subagentHarness.session.bindExtensions({});
		expect(subagentHarness.session.state.tools.some((tool) => tool.name === "todo_list")).toBe(false);
		const result = await requireTool(subagentHarness, "agent_start").execute("agent-only", {
			agent: "worker",
			task: "standalone",
			mode: "foreground",
			scope: "user",
		});
		expect((result.details as AgentToolDetails).records[0]).toMatchObject({ status: "completed" });
		expect(manager?.list()).toHaveLength(1);
	});
});
