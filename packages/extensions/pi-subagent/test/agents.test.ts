import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/agents.ts";

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
		});
		expect(result.diagnostics).toHaveLength(1);
	});
});
