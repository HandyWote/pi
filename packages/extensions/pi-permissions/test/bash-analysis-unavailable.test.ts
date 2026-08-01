import { describe, expect, it, vi } from "vitest";
import { parseBashCommand } from "../src/bash-analysis/parser.ts";

// Simulate a WASM load failure (missing runtime / incompatible grammar) —
// the parser must degrade to parse-unavailable instead of throwing.
vi.mock("web-tree-sitter", () => ({
	Parser: {
		init: () => Promise.reject(new Error("wasm runtime unavailable")),
	},
	Language: {
		load: () => Promise.reject(new Error("grammar wasm incompatible")),
	},
}));

describe("parseBashCommand with unavailable WASM", () => {
	it("returns parse-unavailable when the runtime cannot be loaded", async () => {
		const result = await parseBashCommand("git status");
		expect(result.kind).toBe("parse-unavailable");
		expect(result.kind === "parse-unavailable" ? result.reason : "").toContain("tree-sitter");
	});

	it("still rejects over-length commands without the parser", async () => {
		expect((await parseBashCommand("a".repeat(10001))).kind).toBe("too-complex");
	});
});
