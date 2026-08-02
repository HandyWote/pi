import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DenialAudit, type DenialRecord } from "../src/audit.ts";

const tempRoots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-test-"));
	tempRoots.push(root);
	return root;
}

function makeRecord(overrides: Partial<DenialRecord> = {}): DenialRecord {
	return {
		timestamp: new Date().toISOString(),
		toolName: "bash",
		description: "rm -rf /tmp/pi-test",
		reasonType: "redline",
		reasonDetail: "matches a redline rule",
		mode: "chat",
		headless: false,
		...overrides,
	};
}

function countLines(file: string): number {
	const content = fs.readFileSync(file, "utf8");
	if (content.length === 0) return 0;
	return content.split("\n").filter((l) => l.length > 0).length;
}

describe("DenialAudit", () => {
	it("creates the log file and appends one valid JSON line per record", async () => {
		const file = path.join(tempDir(), "denials.jsonl");
		const audit = new DenialAudit({ logPath: file });
		await audit.record(makeRecord({ toolName: "bash" }));
		await audit.record(makeRecord({ toolName: "write" }));

		const lines = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		const parsed = lines.map((l) => JSON.parse(l) as DenialRecord);
		expect(parsed.map((r) => r.toolName)).toEqual(["bash", "write"]);
	});

	it("returns the last records in write order", async () => {
		const audit = new DenialAudit({ logPath: path.join(tempDir(), "denials.jsonl") });
		for (let i = 1; i <= 5; i++) {
			await audit.record(makeRecord({ description: `cmd-${i}` }));
		}
		const recent = await audit.recent(3);
		expect(recent.map((r) => r.description)).toEqual(["cmd-3", "cmd-4", "cmd-5"]);
	});

	it("caps recent() at 50 by default", async () => {
		const audit = new DenialAudit({ logPath: path.join(tempDir(), "denials.jsonl") });
		for (let i = 1; i <= 60; i++) {
			await audit.record(makeRecord({ description: `cmd-${i}` }));
		}
		const recent = await audit.recent();
		expect(recent).toHaveLength(50);
		expect(recent[0]!.description).toBe("cmd-11");
		expect(recent.at(-1)!.description).toBe("cmd-60");
	});

	it("skips malformed lines and keeps valid ones", async () => {
		const file = path.join(tempDir(), "denials.jsonl");
		fs.writeFileSync(
			file,
			`${["{ not json", JSON.stringify(makeRecord({ description: "valid-1" })), "42", "", JSON.stringify(makeRecord({ description: "valid-2" }))].join("\n")}\n`,
		);
		const audit = new DenialAudit({ logPath: file });
		const recent = await audit.recent();
		expect(recent.map((r) => r.description)).toEqual(["valid-1", "valid-2"]);
	});

	it("truncates the log to the newest half of maxLines", async () => {
		const file = path.join(tempDir(), "denials.jsonl");
		const audit = new DenialAudit({ logPath: file, maxLines: 10 });
		for (let i = 1; i <= 60; i++) {
			await audit.record(makeRecord({ description: `cmd-${i}` }));
		}
		// After each truncation the file holds maxLines / 2 = 5 lines plus
		// whatever was appended before the next truncation triggered.
		expect(countLines(file)).toBeLessThanOrEqual(6);
		const recent = await audit.recent(10);
		expect(recent.at(-1)!.description).toBe("cmd-60");
		expect(recent.length).toBe(countLines(file));
		// The newest record survives verbatim.
		const lastLine = fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!;
		expect((JSON.parse(lastLine) as DenialRecord).description).toBe("cmd-60");
	});

	it("creates the log directory when it does not exist", async () => {
		const file = path.join(tempDir(), "nested", "dir", "denials.jsonl");
		const audit = new DenialAudit({ logPath: file });
		await audit.record(makeRecord());
		expect(fs.existsSync(file)).toBe(true);
		expect(await audit.recent()).toHaveLength(1);
	});

	it("serializes concurrent records without losing any", async () => {
		const audit = new DenialAudit({ logPath: path.join(tempDir(), "denials.jsonl") });
		await Promise.all(
			Array.from({ length: 20 }, (_, i) => audit.record(makeRecord({ description: `cmd-${i + 1}` }))),
		);
		const recent = await audit.recent(20);
		expect(recent.map((r) => r.description)).toEqual(Array.from({ length: 20 }, (_, i) => `cmd-${i + 1}`));
	});

	it("does not reject when the log cannot be written", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		// A path that is an existing directory: appendFile fails with EISDIR.
		const dir = tempDir();
		const audit = new DenialAudit({ logPath: dir });
		await expect(audit.record(makeRecord())).resolves.toBeUndefined();
		await expect(audit.recent()).resolves.toEqual([]);
	});

	it("truncates descriptions longer than 500 characters", async () => {
		const audit = new DenialAudit({ logPath: path.join(tempDir(), "denials.jsonl") });
		await audit.record(makeRecord({ description: "x".repeat(1000) }));
		const recent = await audit.recent();
		expect(recent[0]!.description).toHaveLength(500);
	});
});
