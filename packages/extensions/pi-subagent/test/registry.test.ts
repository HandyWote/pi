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
		version: 2,
		agentId: "agent-1",
		runId: "run-1",
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
		childSessionDir: path.join(root, "sessions", "agent-1"),
		transcriptPath: path.join(root, "transcripts", "agent-1.jsonl"),
		usage: emptyUsage(),
		toolCount: 0,
		lastOutput: "",
		activities: [],
		notified: false,
		lifecycleEventId: "event-1",
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

	it("serializes concurrent changes and keeps memory unchanged when commit fails", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const registry = new AgentRegistry(root, "parent-1");
		const record = fixture(root);
		const save = registry.save(record);
		const update = registry.update("agent-1", (entry) => ({
			...entry,
			status: "running",
			updatedAt: new Date().toISOString(),
		}));
		await Promise.all([save, update]);
		expect(registry.get("agent-1")?.status).toBe("running");

		const failing = new AgentRegistry(root, "parent-1", async () => {
			throw new Error("disk full");
		});
		await failing.load();
		await expect(failing.update("agent-1", (entry) => ({ ...entry, status: "completed" }))).rejects.toThrow(
			"disk full",
		);
		expect(failing.get("agent-1")?.status).toBe("running");
	});

	it("rejects traversal IDs and persisted paths outside its root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		expect(() => new AgentRegistry(root, "../escape")).toThrow("Invalid parent session ID");
		const record = fixture(root);
		record.transcriptPath = path.join(root, "..", "outside.jsonl");
		fs.mkdirSync(path.join(root, "registries"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "registries", "parent-1.json"),
			JSON.stringify({ version: 2, parentSessionId: "parent-1", records: [record] }),
		);
		await expect(new AgentRegistry(root, "parent-1").load()).rejects.toThrow("Invalid transcript path");
	});

	it("rejects incomplete records, duplicate IDs, identity changes, and caller mutation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const record = fixture(root);
		const registry = new AgentRegistry(root, "parent-1");
		await registry.save(record);
		record.status = "completed";
		expect(registry.get("agent-1")?.status).toBe("queued");
		const returned = registry.get("agent-1");
		if (returned) returned.status = "failed";
		expect(registry.get("agent-1")?.status).toBe("queued");
		await expect(registry.update("agent-1", (entry) => ({ ...entry, agentId: "agent-2" }))).rejects.toThrow();

		const incomplete = { ...fixture(root), usage: undefined };
		fs.writeFileSync(
			registry.registryPath,
			JSON.stringify({ version: 2, parentSessionId: "parent-1", records: [incomplete] }),
		);
		await expect(new AgentRegistry(root, "parent-1").load()).rejects.toThrow("Invalid usage");

		fs.writeFileSync(
			registry.registryPath,
			JSON.stringify({ version: 2, parentSessionId: "parent-1", records: [fixture(root), fixture(root)] }),
		);
		await expect(new AgentRegistry(root, "parent-1").load()).rejects.toThrow("Duplicate agent ID");
	});

	it("discards a v1 registry and rewrites it as an empty v2 registry", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const registry = new AgentRegistry(root, "parent-1");
		fs.mkdirSync(path.dirname(registry.registryPath), { recursive: true });
		fs.writeFileSync(
			registry.registryPath,
			JSON.stringify({ version: 1, parentSessionId: "parent-1", records: [{ agentId: "legacy" }] }),
		);

		await registry.load();

		expect(registry.list()).toEqual([]);
		expect(JSON.parse(fs.readFileSync(registry.registryPath, "utf8"))).toEqual({
			version: 2,
			parentSessionId: "parent-1",
			records: [],
		});
	});

	it("rejects unknown future registry versions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const registry = new AgentRegistry(root, "parent-1");
		fs.mkdirSync(path.dirname(registry.registryPath), { recursive: true });
		fs.writeFileSync(registry.registryPath, JSON.stringify({ version: 3, parentSessionId: "parent-1", records: [] }));

		await expect(registry.load()).rejects.toThrow("Invalid subagent registry");
	});
});
