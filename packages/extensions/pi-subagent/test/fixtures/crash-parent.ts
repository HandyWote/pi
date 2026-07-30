import * as fs from "node:fs";
import * as path from "node:path";
import { AgentManager } from "../../src/manager.ts";
import type { AgentDefinition } from "../../src/types.ts";

const root = process.argv[2];
const resultPath = process.argv[3];
const fakePiPath = process.argv[4];
if (!root || !resultPath || !fakePiPath) throw new Error("Expected root, result path, and fake pi path");

const definition: AgentDefinition = {
	name: "worker",
	description: "Crash recovery worker",
	tools: ["read"],
	systemPrompt: "Wait for recovery.",
	source: "user",
	filePath: path.join(root, "worker.md"),
	isolation: "none",
};
const manager = new AgentManager({
	rootDir: path.join(root, "state"),
	parentSessionId: "parent-1",
	defaultCwd: root,
	invocation: { command: process.execPath, prefixArgs: [fakePiPath] },
	killGraceMs: 40,
});
await manager.initialize();
const started = await manager.start(definition, { task: "ignore-term delay:10000", mode: "background" });
let record = manager.get(started.record.agentId);
for (let attempt = 0; attempt < 200 && (record?.status !== "running" || record.pid === undefined); attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	record = manager.get(started.record.agentId);
}
if (record?.status !== "running" || record.pid === undefined) throw new Error("Child did not reach running state");
fs.writeFileSync(resultPath, `${JSON.stringify({ agentId: record.agentId, pid: record.pid })}\n`);
process.exit(0);
