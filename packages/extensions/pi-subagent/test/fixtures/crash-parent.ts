import * as fs from "node:fs";
import * as path from "node:path";
import { AgentManager } from "../../src/manager.ts";
import type { AgentDefinition } from "../../src/types.ts";

const root = process.argv[2];
const resultPath = process.argv[3];
const fakePiPath = process.argv[4];
const mode = process.argv[5];
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
	processIdentityProbe: mode === "block-probe" ? async () => new Promise<string | undefined>(() => {}) : undefined,
});
await manager.initialize();
const readyPath = `${resultPath}.ready`;
const task = mode === "block-probe" ? `ignore-term delay:10000 ready-file:${readyPath}` : "ignore-term delay:10000";
const started = await manager.start(definition, { task, mode: "background" });
let record = manager.get(started.record.agentId);
for (
	let attempt = 0;
	attempt < 200 &&
	(mode === "block-probe" ? !fs.existsSync(readyPath) : record?.status !== "running" || record.pid === undefined);
	attempt++
) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	record = manager.get(started.record.agentId);
}
const pid = mode === "block-probe" ? Number(fs.readFileSync(readyPath, "utf8")) : record?.pid;
if (pid === undefined) throw new Error("Child process identity was not persisted");
fs.writeFileSync(resultPath, `${JSON.stringify({ agentId: record?.agentId, pid })}\n`);
process.exit(0);
