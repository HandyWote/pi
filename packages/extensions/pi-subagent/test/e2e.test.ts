import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@handy_wote/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { createPiSubagent } from "../src/index.ts";
import { AgentManager } from "../src/manager.ts";
import type { AgentToolDetails } from "../src/render.ts";

const fakePiPath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
const harnesses: Harness[] = [];
const extraRoots: string[] = [];

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of extraRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function waitForTerminal(manager: AgentManager, agentId: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const status = manager.get(agentId)?.status;
		if (status && !["queued", "running"].includes(status)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Agent ${agentId} did not finish`);
}

describe("pi-subagent extension", () => {
	it("integrates registration, trust, commands, notification, persistence, and reload", async () => {
		const managers: AgentManager[] = [];
		let stateRoot = "";
		const extension = createPiSubagent({
			notificationDebounceMs: 30,
			createManager: (options) => {
				const manager = new AgentManager({
					...options,
					rootDir: stateRoot,
					parentSessionId: "e2e-parent",
					invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
					killGraceMs: 40,
				});
				managers.push(manager);
				return manager;
			},
		});
		const harness = await createHarness({ extensionFactories: [{ name: "pi-subagent", factory: extension }] });
		harnesses.push(harness);
		stateRoot = path.join(harness.tempDir, "subagent-state");
		process.env.PI_CODING_AGENT_DIR = path.join(harness.tempDir, "agent-home");
		const projectAgentPath = path.join(harness.tempDir, ".pi", "agents", "worker.md");
		fs.mkdirSync(path.dirname(projectAgentPath), { recursive: true });
		fs.writeFileSync(
			projectAgentPath,
			"---\nname: worker\ndescription: E2E worker\ntools: read\n---\nDo the delegated work.\n",
		);
		const confirm = vi.fn(async () => true);
		const notify = vi.fn();
		let commandAgentId = "";
		const select = vi.fn(async (title: string, options: string[]) => {
			if (title === "Agents") return options.find((option) => option.includes(commandAgentId));
			if (title.includes("complete locally")) return "Inspect output";
			return undefined;
		});
		const baseUI = harness.session.extensionRunner.getUIContext();
		const ui = { ...baseUI, confirm, notify, select };
		await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });

		expect(harness.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["agent_start", "agent_list", "agent_output", "agent_stop", "agent_resume"]),
		);
		expect(harness.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain(
			"agents",
		);
		const startTool = harness.session.state.tools.find((tool) => tool.name === "agent_start");
		if (!startTool) throw new Error("agent_start was not active");
		const unknown = await startTool.execute("unknown", {
			agent: "missing",
			task: "denied",
			mode: "background",
			scope: "project",
		});
		expect(unknown.content[0]).toMatchObject({ text: expect.stringContaining("Available agents: worker") });
		expect(unknown.content[0]).not.toMatchObject({ text: expect.stringContaining("Do the delegated work") });

		harness.settingsManager.setProjectTrusted(false);
		const denied = await startTool.execute("denied", {
			agent: "worker",
			task: "denied",
			mode: "background",
			scope: "project",
		});
		expect(denied.content[0]).toMatchObject({ text: expect.stringContaining("not trusted") });
		expect(confirm).not.toHaveBeenCalled();

		harness.settingsManager.setProjectTrusted(true);
		harness.setResponses([fauxAssistantMessage("notification handled")]);
		const launched = await startTool.execute("launched", {
			agent: "worker",
			task: "complete locally",
			mode: "background",
			scope: "project",
			metadata: { correlation: "opaque" },
		});
		const details = launched.details as AgentToolDetails;
		const agentId = details.records[0]!.agentId;
		commandAgentId = agentId;
		await waitForTerminal(managers[0]!, agentId);
		for (let attempt = 0; attempt < 200 && notify.mock.calls.length === 0; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(confirm).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledOnce();
		await vi.waitFor(
			() => {
				const notification = harness.session.messages.find(
					(message) => message.role === "custom" && message.customType === "pi-subagent-notification",
				);
				expect(getMessageText(notification)).toContain("historical and may have been superseded");
				expect(getMessageText(notification)).toContain("call agent_list");
			},
			{ timeout: 5000, interval: 10 },
		);
		expect(managers[0]!.get(agentId)).toMatchObject({ status: "completed" });
		const listTool = harness.session.state.tools.find((tool) => tool.name === "agent_list");
		const resumeTool = harness.session.state.tools.find((tool) => tool.name === "agent_resume");
		if (!listTool || !resumeTool) throw new Error("Agent list and resume tools were not active");
		const listed = await listTool.execute("list", {});
		expect(listed.content[0]).toMatchObject({ text: expect.stringContaining("worker [project]: E2E worker") });
		expect(listed.content[0]).toMatchObject({ text: expect.stringContaining(agentId) });
		expect((listed.details as AgentToolDetails).definitions?.[0]).toEqual({
			name: "worker",
			source: "project",
			description: "E2E worker",
		});
		expect(JSON.stringify((listed.details as AgentToolDetails).definitions)).not.toContain("Do the delegated work");
		await harness.session.prompt("/agents");
		expect(select.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining([expect.stringContaining("worker [project]"), expect.stringContaining(agentId)]),
		);
		expect(notify.mock.calls.some((call) => String(call[0]).includes(`ID: ${agentId}`))).toBe(true);

		harness.settingsManager.setProjectTrusted(false);
		const revoked = await resumeTool.execute("revoked", { agentId, prompt: "must not run", mode: "background" });
		expect(revoked.content[0]).toMatchObject({ text: expect.stringContaining("not trusted") });
		expect(managers[0]!.get(agentId)?.status).toBe("completed");
		const hiddenList = await listTool.execute("untrusted-list", {});
		const hiddenText = JSON.stringify(hiddenList);
		expect(hiddenText).not.toContain("E2E worker");
		expect(hiddenText).not.toContain("Do the delegated work");
		expect(hiddenList.content[0]).toMatchObject({
			text: expect.stringContaining("worker [built-in]"),
		});
		await harness.session.prompt("/agents");
		expect(select.mock.calls.at(-1)?.[1]).toEqual(
			expect.arrayContaining([
				expect.stringContaining("worker [built-in]"),
				expect.stringContaining("explore [built-in]"),
			]),
		);

		harness.settingsManager.setProjectTrusted(true);
		harness.session.extensionRunner.setUIContext(undefined, "print");
		const headless = await resumeTool.execute("headless", { agentId, prompt: "must not run", mode: "background" });
		expect(headless.content[0]).toMatchObject({ text: expect.stringContaining("interactive confirmation") });
		expect(managers[0]!.get(agentId)?.status).toBe("completed");
		harness.session.extensionRunner.setUIContext(ui, "tui");

		confirm.mockResolvedValueOnce(false);
		const declined = await resumeTool.execute("declined", { agentId, prompt: "must not run", mode: "background" });
		expect(declined.content[0]).toMatchObject({ text: expect.stringContaining("not approved") });
		expect(managers[0]!.get(agentId)?.status).toBe("completed");

		harness.appendResponses([fauxAssistantMessage("resume notification handled")]);
		const approved = await resumeTool.execute("approved", { agentId, prompt: "continue", mode: "background" });
		expect(approved.content[0]).toMatchObject({ text: expect.stringContaining(`Resumed ${agentId}`) });
		await waitForTerminal(managers[0]!, agentId);
		for (
			let attempt = 0;
			attempt < 200 &&
			notify.mock.calls.filter((call) => String(call[0]).startsWith("worker completed:")).length < 2;
			attempt++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(confirm).toHaveBeenCalledTimes(3);
		expect(notify.mock.calls.filter((call) => String(call[0]).startsWith("worker completed:")).length).toBe(2);
		const resumedRecord = managers[0]!.get(agentId);
		if (!resumedRecord?.childSessionPath) throw new Error("Expected durable child session");
		const childSession = fs.readFileSync(resumedRecord.childSessionPath, "utf8");
		expect(childSession).toContain("Task: complete locally");
		expect(childSession).toContain("Task: continue");

		await harness.session.reload();
		expect(managers).toHaveLength(2);
		expect(managers[1]!.get(agentId)).toMatchObject({ status: "completed", notified: true });
		expect(notify.mock.calls.filter((call) => String(call[0]).startsWith("worker completed:")).length).toBe(2);
	});

	it("merges terminal notifications for agents completing within the debounce window", async () => {
		let manager: AgentManager | undefined;
		let stateRoot = "";
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "pi-subagent",
					factory: createPiSubagent({
						notificationDebounceMs: 200,
						createManager: (options) => {
							manager = new AgentManager({
								...options,
								rootDir: stateRoot,
								parentSessionId: "e2e-parent",
								invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
								killGraceMs: 40,
							});
							return manager;
						},
					}),
				},
			],
		});
		harnesses.push(harness);
		stateRoot = path.join(harness.tempDir, "subagent-state");
		process.env.PI_CODING_AGENT_DIR = path.join(harness.tempDir, "agent-home");
		const userAgentDir = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(userAgentDir, "worker.md"),
			"---\nname: worker\ndescription: E2E worker\n---\nDo the delegated work.\n",
		);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("merged notification handled")]);
		const startTool = harness.session.state.tools.find((tool) => tool.name === "agent_start");
		if (!startTool) throw new Error("agent_start was not active");
		const launched = await startTool.execute("batch", {
			tasks: [
				{ agent: "worker", task: "delay:50 first" },
				{ agent: "worker", task: "delay:60 second" },
				{ agent: "worker", task: "delay:70 third" },
			],
			mode: "background",
			scope: "user",
		});
		expect(launched.content[0]).toMatchObject({ text: expect.stringContaining("Launched") });
		const records = (launched.details as AgentToolDetails).records;
		for (const record of records) await waitForTerminal(manager!, record.agentId);
		await vi.waitFor(
			() => {
				const notifications = harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "pi-subagent-notification",
				);
				expect(notifications).toHaveLength(1);
				const text = getMessageText(notifications[0]);
				expect(text).toContain("3 subagents reached terminal state");
				for (const record of records) expect(text).toContain(record.agentId);
			},
			{ timeout: 5000, interval: 10 },
		);
	});

	it("propagates the wrapped tool AbortSignal to a stubborn child", async () => {
		let manager: AgentManager | undefined;
		let stateRoot = "";
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "pi-subagent",
					factory: createPiSubagent({
						createManager: (options) => {
							manager = new AgentManager({
								...options,
								rootDir: stateRoot,
								invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
								killGraceMs: 40,
							});
							return manager;
						},
					}),
				},
			],
		});
		harnesses.push(harness);
		stateRoot = path.join(harness.tempDir, "subagent-state");
		process.env.PI_CODING_AGENT_DIR = path.join(harness.tempDir, "agent-home");
		const userAgentDir = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(userAgentDir, "worker.md"),
			"---\nname: worker\ndescription: E2E worker\n---\nWait.\n",
		);
		await harness.session.bindExtensions({});
		const startTool = harness.session.state.tools.find((tool) => tool.name === "agent_start");
		const outputTool = harness.session.state.tools.find((tool) => tool.name === "agent_output");
		const stopTool = harness.session.state.tools.find((tool) => tool.name === "agent_stop");
		if (!startTool || !outputTool || !stopTool) throw new Error("Agent execution tools were not active");
		const background = await startTool.execute("background", {
			agent: "worker",
			task: "ignore-term delay:10000",
			mode: "background",
			scope: "user",
		});
		const backgroundId = (background.details as AgentToolDetails).records[0]!.agentId;
		for (let attempt = 0; attempt < 500 && manager?.get(backgroundId)?.status !== "running"; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		const runningOutput = await outputTool.execute("running-output", {
			agentId: backgroundId,
			block: false,
		});
		expect(runningOutput.content[0]).toMatchObject({ text: expect.stringContaining("Result: not_ready") });
		await stopTool.execute("stop", { agentId: backgroundId });
		const terminalOutput = await outputTool.execute("terminal-output", { agentId: backgroundId, block: true });
		expect(terminalOutput.content[0]).toMatchObject({ text: expect.stringContaining("stopped") });

		const existingAgentIds = new Set(manager?.list().map((record) => record.agentId) ?? []);
		const controller = new AbortController();
		const execution = startTool.execute(
			"abort",
			{ agent: "worker", task: "ignore-term delay:10000", mode: "foreground", scope: "user" },
			controller.signal,
		);
		let foregroundId: string | undefined;
		for (let attempt = 0; attempt < 500 && foregroundId === undefined; attempt++) {
			foregroundId = manager?.list().find((record) => !existingAgentIds.has(record.agentId))?.agentId;
			if (foregroundId === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (!foregroundId) throw new Error("Foreground agent was not registered");
		for (let attempt = 0; attempt < 500 && !manager?.get(foregroundId)?.lastOutput; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const result = await execution;
		expect((result.details as AgentToolDetails).records[0]).toMatchObject({
			agentId: foregroundId,
			status: "stopped",
		});
	});

	it("queues batch work at configured concurrency and preserves worktree-relative cwd", async () => {
		let manager: AgentManager | undefined;
		let maximumActive = 0;
		const terminalCleanupStates = new Map<
			string,
			{ worktreePath: string | undefined; cleanupError: string | undefined }
		>();
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "pi-subagent",
					factory: createPiSubagent({
						createManager: (options) => {
							manager = new AgentManager({
								...options,
								rootDir: extraRoots[0]!,
								concurrency: 1,
								invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
								killGraceMs: 40,
							});
							manager.subscribe((event) => {
								maximumActive = Math.max(maximumActive, manager?.getActiveCount() ?? 0);
								if (event.status === "queued" || event.status === "running") return;
								const terminal = manager?.get(event.agentId);
								terminalCleanupStates.set(event.agentId, {
									worktreePath: terminal?.worktreePath,
									cleanupError: terminal?.cleanupError,
								});
							});
							return manager;
						},
					}),
				},
			],
		});
		harnesses.push(harness);
		extraRoots.push(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-e2e-state-")));
		execFileSync("git", ["init"], { cwd: harness.tempDir });
		fs.mkdirSync(path.join(harness.tempDir, "packages", "worker"), { recursive: true });
		fs.writeFileSync(path.join(harness.tempDir, "README.md"), "test\n");
		fs.writeFileSync(path.join(harness.tempDir, "packages", "worker", "README.md"), "worker\n");
		execFileSync("git", ["add", "README.md", "packages/worker/README.md"], { cwd: harness.tempDir });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
			cwd: harness.tempDir,
		});
		process.env.PI_CODING_AGENT_DIR = path.join(harness.tempDir, "agent-home");
		const userAgentDir = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(userAgentDir, "worker.md"),
			"---\nname: worker\ndescription: Worktree worker\nisolation: worktree\n---\nWork in isolation.\n",
		);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("first worktree notification handled"),
			fauxAssistantMessage("second worktree notification handled"),
		]);
		const startTool = harness.session.state.tools.find((tool) => tool.name === "agent_start");
		if (!startTool) throw new Error("agent_start was not active");
		const launched = await startTool.execute("batch", {
			tasks: [
				{ agent: "worker", task: "delay:80 first", cwd: "packages/worker" },
				{ agent: "worker", task: "delay:80 second", cwd: "packages/worker" },
			],
			mode: "background",
			scope: "user",
		});
		const records = (launched.details as AgentToolDetails).records;
		for (const record of records) await waitForTerminal(manager!, record.agentId);

		expect(maximumActive).toBe(1);
		for (const record of records) {
			const terminal = manager!.get(record.agentId)!;
			expect(terminal.worktreeBranch).toBe(`pi-subagent/${record.agentId}`);
			expect(terminal.cleanupError).toBeUndefined();
			expect(terminal.worktreePath).toBeUndefined();
			expect(terminalCleanupStates.get(record.agentId)).toEqual({
				worktreePath: undefined,
				cleanupError: undefined,
			});
			expect(await manager!.registry.readTranscript(record.agentId)).toContain(
				path.join(extraRoots[0]!, "worktrees", record.agentId, "packages", "worker"),
			);
		}
	});
});
