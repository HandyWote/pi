import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, loadAgentPrompt } from "../src/agents.ts";

const tempRoots: string[] = [];
afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("discoverAgents", () => {
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

		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({
			name: "worker",
			description: "Project worker",
			source: "project",
			isolation: "worktree",
			displayName: "Builder",
			systemPrompt: "",
		});
		expect(loadAgentPrompt(result.agents[0]!)).toMatchObject({ systemPrompt: "Project prompt" });
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

		expect(result.agents.map((agent) => agent.name)).toEqual(["worker"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"Agent requires a non-empty system prompt",
				"Invalid color: #oops",
				"Duplicate user agent: worker",
			]),
		);
	});
});
