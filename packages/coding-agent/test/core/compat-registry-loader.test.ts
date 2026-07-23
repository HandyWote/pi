import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_COMPAT_REGISTRY, lookupCompatOverlay } from "@handy_wote/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCompatRegistries } from "../../src/core/compat-registry-loader.ts";

function registry(modelId: string, supportsStore: boolean) {
	return {
		version: 1,
		families: [],
		models: [
			{
				id: modelId,
				apis: { "openai-completions": { compat: { supportsStore } } },
			},
		],
	};
}

describe("loadCompatRegistries", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-compat-registry-loader-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("always returns the builtin as the lowest-priority source", () => {
		const result = loadCompatRegistries();
		expect(result).toEqual({ registries: [BUILTIN_COMPAT_REGISTRY], diagnostics: [] });
	});

	it("resolves relative paths against each source baseDir", () => {
		const settingsDir = join(testDir, "project", ".pi");
		mkdirSync(join(settingsDir, "registries"), { recursive: true });
		writeFileSync(join(settingsDir, "registries", "models.json"), JSON.stringify(registry("relative-model", true)));

		const result = loadCompatRegistries([{ type: "file", path: "registries/models.json", baseDir: settingsDir }]);

		expect(result.diagnostics).toEqual([]);
		expect(lookupCompatOverlay(result.registries, "relative-model", "openai-completions")?.compat).toEqual({
			supportsStore: true,
		});
	});

	it("expands leading tilde before resolving the path", () => {
		const homeDir = join(testDir, "home");
		mkdirSync(homeDir, { recursive: true });
		writeFileSync(join(homeDir, "models.json"), JSON.stringify(registry("home-model", true)));

		const result = loadCompatRegistries([{ type: "file", path: "~/models.json" }], { homeDir });

		expect(result.diagnostics).toEqual([]);
		expect(lookupCompatOverlay(result.registries, "home-model", "openai-completions")?.compat).toEqual({
			supportsStore: true,
		});
	});

	it("preserves file source order for source-first lookup", () => {
		const firstPath = join(testDir, "first.json");
		const secondPath = join(testDir, "second.json");
		writeFileSync(firstPath, JSON.stringify(registry("ordered-model", false)));
		writeFileSync(
			secondPath,
			JSON.stringify({
				version: 1,
				families: [
					{
						id: "later-family",
						match: { prefixes: ["ordered-"] },
						apis: { "openai-completions": { compat: { supportsStore: true } } },
					},
				],
			}),
		);

		const result = loadCompatRegistries([
			{ type: "file", path: firstPath },
			{ type: "file", path: secondPath },
		]);

		expect(result.registries).toHaveLength(3);
		expect(lookupCompatOverlay(result.registries, "ordered-model", "openai-completions")?.compat).toEqual({
			supportsStore: true,
		});
	});

	it("skips missing, malformed, and invalid files independently", () => {
		const malformedPath = join(testDir, "malformed.json");
		const invalidPath = join(testDir, "invalid.json");
		const validPath = join(testDir, "valid.json");
		writeFileSync(malformedPath, "{not-json");
		writeFileSync(
			invalidPath,
			JSON.stringify({ version: 1, families: [], models: [{ id: "invalid", metadata: { contextWindow: 0 } }] }),
		);
		writeFileSync(validPath, JSON.stringify(registry("valid-model", true)));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = loadCompatRegistries([
			{ type: "file", path: join(testDir, "missing.json") },
			{ type: "file", path: malformedPath },
			{ type: "file", path: invalidPath },
			{ type: "file", path: validPath },
		]);

		expect(result.registries).toHaveLength(2);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"file-not-found",
			"invalid-json",
			"invalid-registry",
		]);
		expect(result.diagnostics[2]?.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "/models/0/metadata/contextWindow" })]),
		);
		expect(lookupCompatOverlay(result.registries, "valid-model", "openai-completions")?.compat).toEqual({
			supportsStore: true,
		});
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("rejects invalid source descriptors without affecting valid sources", () => {
		const validPath = join(testDir, "valid.json");
		writeFileSync(validPath, JSON.stringify(registry("valid-model", true)));

		const result = loadCompatRegistries([
			{ type: "git", path: "repo" },
			{ type: "file", path: validPath, unexpected: true },
			{ type: "file", path: validPath },
		]);

		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid-source", "invalid-source"]);
		expect(result.registries).toHaveLength(2);
	});
});
