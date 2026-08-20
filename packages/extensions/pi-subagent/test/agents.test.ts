import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, loadAgentPrompt } from "../src/agents.ts";
import { resolveBuiltInAgentTools } from "../src/built-in-agents.ts";
import { actionHint, terminalNotificationContent } from "../src/index.ts";
import type { AgentRecord } from "../src/types.ts";

function notificationRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		version: 2,
		agentId: "agent-1",
		runId: "run-1",
		parentSessionId: "session-1",
		definition: {
			name: "worker",
			description: "Worker agent",
			systemPrompt: "",
			source: "built-in",
			filePath: "worker.md",
			isolation: "none",
		},
		task: "Investigate the failure",
		mode: "background",
		status: "completed",
		cwd: "/tmp",
		isolation: "none",
		metadata: {},
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
		childSessionId: "child-1",
		childSessionDir: "/tmp/child-1",
		transcriptPath: "/tmp/child-1/transcript.md",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		toolCount: 0,
		lastOutput: "",
		activities: [],
		notified: false,
		lifecycleEventId: "event-1",
		...overrides,
	};
}

const tempRoots: string[] = [];
afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("discoverAgents", () => {
	it("provides built-in agents without configuration", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
		tempRoots.push(root);
		process.env.PI_CODING_AGENT_DIR = path.join(root, "missing-agent-home");

		const result = discoverAgents(root, "user");

		expect(result.agents.map(({ name, source }) => ({ name, source }))).toEqual([
			{ name: "worker", source: "built-in" },
			{ name: "explore", source: "built-in" },
		]);
	});

	it("validates definitions and lets project agents override user agents", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
		tempRoots.push(root);
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "agents", "worker.md"),
			"---\nname: worker\ndescription: User worker\ntools: read, grep\n---\nUser prompt\n",
		);
		fs.writeFileSync(
			path.join(project, ".pi", "agents", "worker.md"),
			"---\nname: worker\ndescription: Project worker\nisolation: worktree\ndisplayName: Builder\n---\nProject prompt\n",
		);
		fs.writeFileSync(
			path.join(project, ".pi", "agents", "bad.md"),
			"---\nname: bad name\ndescription: Invalid\n---\nPrompt\n",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = discoverAgents(project, "both");

		expect(result.agents).toHaveLength(2);
		expect(result.agents.find((agent) => agent.name === "worker")).toMatchObject({
			name: "worker",
			description: "Project worker",
			source: "project",
			isolation: "worktree",
			displayName: "Builder",
			systemPrompt: "",
		});
		expect(loadAgentPrompt(result.agents.find((agent) => agent.name === "worker")!)).toMatchObject({
			systemPrompt: "Project prompt",
		});
		expect(result.diagnostics).toHaveLength(1);
	});

	it("rejects a project agent whose approved metadata changes before prompt loading", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
		tempRoots.push(root);
		const agentPath = path.join(root, ".pi", "agents", "worker.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(agentPath, "---\nname: worker\ndescription: Before\n---\nOriginal prompt\n");
		const discovered = discoverAgents(root, "project").agents[0]!;
		fs.writeFileSync(agentPath, "---\nname: worker\ndescription: After\n---\nReplaced prompt\n");

		expect(() => loadAgentPrompt(discovered)).toThrow("changed after approval");
	});

	it("reports invalid prompts, display metadata, and same-source duplicates", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
		tempRoots.push(root);
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "one.md"), "---\nname: worker\ndescription: One\n---\nPrompt\n");
		fs.writeFileSync(path.join(agentDir, "agents", "two.md"), "---\nname: worker\ndescription: Two\n---\nPrompt\n");
		fs.writeFileSync(path.join(agentDir, "agents", "empty.md"), "---\nname: empty\ndescription: Empty\n---\n");
		fs.writeFileSync(
			path.join(agentDir, "agents", "color.md"),
			"---\nname: color\ndescription: Color\ncolor: '#oops'\n---\nPrompt\n",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = discoverAgents(root, "user");

		expect(result.agents.map((agent) => agent.name)).toEqual(["worker", "explore"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"Agent requires a non-empty system prompt",
				"Invalid color: #oops",
				"Duplicate user agent: worker",
			]),
		);
	});

	it("lets user definitions override built-ins and constrains built-in tools", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
		tempRoots.push(root);
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "agents", "worker.md"),
			"---\nname: worker\ndescription: Custom worker\ntools: read\n---\nCustom prompt\n",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const agents = discoverAgents(root, "user").agents;
		const worker = agents.find((agent) => agent.name === "worker")!;
		const explore = agents.find((agent) => agent.name === "explore")!;

		expect(worker.source).toBe("user");
		expect(resolveBuiltInAgentTools(worker, ["read", "write", "agent_start"])).toMatchObject({
			tools: ["read"],
		});
		expect(resolveBuiltInAgentTools(explore, ["write", "grep", "read", "agent_start", "find"])).toMatchObject({
			tools: ["grep", "read", "find"],
		});
		expect(
			resolveBuiltInAgentTools({ ...explore, name: "worker" }, [
				"read",
				"write",
				"todo_update",
				"agent_start",
				"agent_output",
			]).tools,
		).toEqual(["read", "write", "todo_update"]);
	});
});

describe("terminal notifications", () => {
	it("gives a neutral hint for completed agents without a resume directive", () => {
		const completed = actionHint(notificationRecord({ status: "completed" }));
		expect(completed).toBe("Result available via agent_list");
		expect(completed).not.toMatch(/agent_resume|Continue/);
		expect(actionHint(notificationRecord({ status: "failed" }))).toBe("Stop: do not resume");
		expect(actionHint(notificationRecord({ status: "stopped" }))).toBe("Stop: do not resume");
	});

	it("truncates the task to its first line in single-agent notifications", () => {
		const task = `${"a".repeat(200)}\nsecond line that must not appear`;
		const content = terminalNotificationContent([notificationRecord({ status: "completed", task })]);

		expect(content).toContain(`Task: ${"a".repeat(157)}...`);
		expect(content).not.toContain("second line");
		expect(content).not.toContain("agent_resume");
	});

	it("summarizes multi-agent batches with per-agent task excerpts", () => {
		const content = terminalNotificationContent([
			notificationRecord({ agentId: "agent-1", status: "completed", task: "First task" }),
			notificationRecord({ agentId: "agent-2", status: "failed", task: "Second task" }),
		]);

		expect(content).toContain("2 subagents reached terminal state. Before acting, call agent_list.");
		expect(content).toContain("1. Subagent agent-1 (worker) completed. Task: First task.");
		expect(content).toContain("Result available via agent_list.");
		expect(content).toContain("2. Subagent agent-2 (worker) failed. Task: Second task.");
		expect(content).toContain("Stop: do not resume.");
		expect(content).not.toContain("agent_resume");
	});
});
