import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/registry.ts";
import { MAX_TRANSCRIPT_BYTES, TranscriptBuffer } from "../src/transcript-buffer.ts";
import { type AgentRecord, emptyUsage } from "../src/types.ts";

const tempRoots: string[] = [];

function fixture(root: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
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
		usage: emptyUsage(),
		toolCount: 0,
		lastOutput: "",
		activities: [],
		notified: false,
		lifecycleEventId: "event-1",
		...overrides,
	};
}

afterEach(() => {
	for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentRegistry", () => {
	it("atomically persists records and keeps transcripts in memory", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const registry = new AgentRegistry(root, "parent-1");
		await registry.save(fixture(root));
		registry.appendTranscript("agent-1", { type: "message", text: "done" });
		const restored = new AgentRegistry(root, "parent-1");
		await restored.load();
		expect(restored.get("agent-1")?.metadata).toEqual({ correlation: "opaque" });
		expect(fs.readdirSync(root)).toEqual(["registries"]);
		expect(fs.readdirSync(path.join(root, "registries"))).toEqual(["parent-1.json"]);
		// Transcripts are process-local memory, not persisted state.
		expect(restored.readTranscript("agent-1")).toBe("");
		expect(registry.readTranscript("agent-1")).toContain('"text":"done"');
	});

	it("persists built-in definitions with controlled virtual paths", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const registry = new AgentRegistry(root, "parent-1");
		const record = fixture(root);
		record.definition = {
			...record.definition,
			source: "built-in",
			filePath: "built-in:worker",
		};

		await registry.save(record);
		const restored = new AgentRegistry(root, "parent-1");
		await restored.load();
		expect(restored.get("agent-1")?.definition).toMatchObject({
			name: "worker",
			source: "built-in",
			filePath: "built-in:worker",
		});

		await expect(
			registry.save({
				...record,
				definition: { ...record.definition, filePath: "built-in:explore" },
			}),
		).rejects.toThrow("Invalid definition for agent agent-1");
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

	it("loads legacy v2 records that still carry a transcriptPath", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		const legacy = { ...fixture(root), transcriptPath: path.join(root, "transcripts", "agent-1.jsonl") };
		fs.mkdirSync(path.join(root, "registries"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "registries", "parent-1.json"),
			JSON.stringify({ version: 2, parentSessionId: "parent-1", records: [legacy] }),
		);

		const registry = new AgentRegistry(root, "parent-1");
		await registry.load();

		expect(registry.get("agent-1")?.agentId).toBe("agent-1");
		expect("transcriptPath" in (registry.get("agent-1") as unknown as Record<string, unknown>)).toBe(false);
	});

	it("rejects traversal IDs and persisted paths outside its root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-"));
		tempRoots.push(root);
		expect(() => new AgentRegistry(root, "../escape")).toThrow("Invalid parent session ID");
		const record = fixture(root);
		record.childSessionDir = path.join(root, "..", "outside");
		fs.mkdirSync(path.join(root, "registries"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "registries", "parent-1.json"),
			JSON.stringify({ version: 2, parentSessionId: "parent-1", records: [record] }),
		);
		await expect(new AgentRegistry(root, "parent-1").load()).rejects.toThrow("Invalid session path");
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

describe("TranscriptBuffer", () => {
	function bufferWith(lines: string[]): TranscriptBuffer {
		const buffer = new TranscriptBuffer();
		for (const line of lines) buffer.append("agent-1", line);
		return buffer;
	}

	it("keeps lines under the byte cap and evicts oldest first", () => {
		const buffer = new TranscriptBuffer();
		const big = "x".repeat(60_000);
		buffer.append("agent-1", big);
		buffer.append("agent-1", big);
		buffer.append("agent-1", big);
		buffer.append("agent-1", big); // 4 x ~60KB > 200KB cap: the first line must be evicted
		const window = buffer.getLinesSince("agent-1", 0);
		expect(window.lines).toHaveLength(3);
		// fromSeq=0 asks for the full buffer; eviction is only flagged for a cursor
		// that points at dropped lines.
		expect(window.evicted).toBe(false);
		// The first line (seq 1) was evicted: a cursor at seq 1 is stale, while a
		// cursor at the oldest surviving line (seq 2) is still served.
		expect(buffer.getLinesSince("agent-1", 1).evicted).toBe(true);
		expect(buffer.getLinesSince("agent-1", 2).evicted).toBe(false);
	});

	it("keeps the newest line even when it alone exceeds the cap", () => {
		const buffer = new TranscriptBuffer();
		buffer.append("agent-1", "y".repeat(MAX_TRANSCRIPT_BYTES + 10));
		expect(buffer.read("agent-1")).toBe(`${"y".repeat(MAX_TRANSCRIPT_BYTES + 10)}\n`);
	});

	it("returns an empty tail for unknown agents", () => {
		const buffer = new TranscriptBuffer();
		expect(buffer.read("missing")).toBe("");
		expect(buffer.getLinesSince("missing", 0)).toEqual({ lines: [], lastSeq: 0, evicted: false });
	});

	it("serves the tail window like the previous file-based readTranscript", () => {
		const lines = ["one", "two", "three"];
		expect(bufferWith(lines).read("agent-1", 200)).toBe("one\ntwo\nthree\n");
		const tail = bufferWith(lines).read("agent-1", 9);
		expect(tail).toBe("two\nthree\n");
		expect(bufferWith(lines).read("agent-1", 5)).toBe("three\n");
	});

	it("tracks monotonic sequence numbers across eviction", () => {
		const buffer = bufferWith(["a", "b", "c"]);
		const first = buffer.getLinesSince("agent-1", 0);
		expect(first.lines).toEqual(["a", "b", "c"]);
		expect(first.lastSeq).toBe(3);
		buffer.append("agent-1", "d");
		const increment = buffer.getLinesSince("agent-1", first.lastSeq);
		expect(increment).toEqual({ lines: ["d"], lastSeq: 4, evicted: false });
	});

	it("flags eviction so incremental readers reset to the full buffer", () => {
		const buffer = bufferWith(["a", "b", "c"]);
		buffer.getLinesSince("agent-1", 0);
		buffer.append("agent-1", "d".repeat(MAX_TRANSCRIPT_BYTES + 1)); // evicts everything before
		const window = buffer.getLinesSince("agent-1", 2);
		expect(window.evicted).toBe(true);
		expect(window.lines).toEqual(["d".repeat(MAX_TRANSCRIPT_BYTES + 1)]);
	});

	it("clears one agent and everything", () => {
		const buffer = bufferWith(["a"]);
		buffer.append("agent-2", "b");
		buffer.clear("agent-1");
		expect(buffer.read("agent-1")).toBe("");
		expect(buffer.read("agent-2")).toBe("b\n");
		buffer.clearAll();
		expect(buffer.read("agent-2")).toBe("");
	});
});
