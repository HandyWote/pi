import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/registry.ts";
import { type AgentRecord, emptyUsage } from "../src/types.ts";

const tempRoots: string[] = [];

function fixture(root: string): AgentRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		agentId: "agent-1",
		parentSessionId: "parent-1",
		definition: {
			name: "worker",
			description: "Worker",
			systemPrompt: "Work",
			source: "user",
			filePath: "/tmp/worker.md",
			isolation: "none",
		},
		task: "Do work",
		mode: "background",
		status: "queued",
		cwd: "/tmp",
		isolation: "none",
		metadata: { correlation: "opaque" },
		createdAt: now,
		updatedAt: now,
		childSessionId: "agent-1",
		childSessionDir: path.join(root, "sessions"),
		transcriptPath: path.join(root, "transcripts", "agent-1.jsonl"),
		usage: emptyUsage(),
		toolCount: 0,
		lastOutput: "",
		activities: [],
		notified: false,
	};
}

afterEach(() => {
	for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentRegistry", () => {
	it("atomically persists records and transcripts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const registry = new AgentRegistry(root, "parent-1");
		await registry.save(fixture(root));
		await registry.appendTranscript("agent-1", { type: "message", text: "done" });
		const restored = new AgentRegistry(root, "parent-1");
		await restored.load();
		expect(restored.get("agent-1")?.metadata).toEqual({ correlation: "opaque" });
		expect(await restored.readTranscript("agent-1")).toContain('"text":"done"');
		expect(fs.readdirSync(path.join(root, "registries"))).toEqual(["parent-1.json"]);
	});

	it("rejects corrupt registry files with a clear diagnostic", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		fs.mkdirSync(path.join(root, "registries"), { recursive: true });
		fs.writeFileSync(path.join(root, "registries", "parent-1.json"), "not-json");
		await expect(new AgentRegistry(root, "parent-1").load()).rejects.toThrow("Cannot load subagent registry");
	});
});
