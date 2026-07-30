import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@handy_wote/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { createPiSubagent } from "../src/index.ts";
import { AgentManager } from "../src/manager.ts";
import type { AgentToolDetails } from "../src/render.ts";

const fakePiPath = fileURLToPath(new URL("fixtures/fake-pi.mjs", import.meta.url));
const harnesses: Harness[] = [];

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const harness of harnesses.splice(0)) harness.cleanup();
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
		const baseUI = harness.session.extensionRunner.getUIContext();
		await harness.session.bindExtensions({ uiContext: { ...baseUI, confirm, notify }, mode: "tui" });

		expect(harness.session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["agent_start", "agent_list", "agent_output", "agent_stop", "agent_resume"]),
		);
		expect(harness.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain(
			"agents",
		);
		const startTool = harness.session.state.tools.find((tool) => tool.name === "agent_start");
		if (!startTool) throw new Error("agent_start was not active");

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
		await waitForTerminal(managers[0]!, agentId);
		for (let attempt = 0; attempt < 200 && notify.mock.calls.length === 0; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(confirm).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledOnce();
		expect(managers[0]!.get(agentId)).toMatchObject({ status: "completed" });

		await harness.session.reload();
		expect(managers).toHaveLength(2);
		expect(managers[1]!.get(agentId)).toMatchObject({ status: "completed", notified: true });
		expect(notify).toHaveBeenCalledOnce();
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
		if (!startTool) throw new Error("agent_start was not active");
		const controller = new AbortController();
		const execution = startTool.execute(
			"abort",
			{ agent: "worker", task: "ignore-term delay:10000", mode: "foreground", scope: "user" },
			controller.signal,
		);
		for (let attempt = 0; attempt < 500 && !manager?.list().some((record) => record.lastOutput); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const result = await execution;
		expect((result.details as AgentToolDetails).records[0]).toMatchObject({ status: "stopped" });
	});
});
