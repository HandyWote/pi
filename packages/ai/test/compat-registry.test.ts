import { describe, expect, it } from "vitest";
import {
	BUILTIN_COMPAT_REGISTRY,
	CompatRegistryValidationError,
	compileCompatRegistry,
	lookupCompatOverlay,
	lookupModelCompatOverlay,
	type ModelCompatRegistry,
	validateCompatRegistry,
} from "../src/compat-registry/index.ts";

function compile(registry: ModelCompatRegistry) {
	return compileCompatRegistry(registry);
}

describe("compat registry lookup", () => {
	it("applies the first family and then the exact model within one source", () => {
		const registry = compile({
			version: 1,
			families: [
				{
					id: "first",
					match: { prefixes: ["foo-"] },
					metadata: { reasoning: true, contextWindow: 10_000 },
					apis: { "openai-completions": { compat: { thinkingFormat: "openai", supportsStore: true } } },
				},
				{
					id: "second",
					match: { prefixes: ["foo-"] },
					metadata: { reasoning: false },
					apis: { "openai-completions": { compat: { thinkingFormat: "deepseek" } } },
				},
			],
			models: [
				{
					id: "foo-1",
					metadata: { contextWindow: 20_000 },
					apis: { "openai-completions": { compat: { supportsStore: false } } },
				},
			],
		});

		expect(lookupCompatOverlay([registry], "foo-1", "openai-completions")).toEqual({
			metadata: { reasoning: true, contextWindow: 20_000 },
			group: undefined,
			preferredApis: undefined,
			compat: { thinkingFormat: "openai", supportsStore: false },
			thinkingLevelMap: undefined,
		});
	});

	it("lets a later source family override an earlier source exact entry", () => {
		const builtin = compile({
			version: 1,
			families: [],
			models: [
				{
					id: "foo-1",
					metadata: {
						reasoning: true,
						cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
					},
					group: { id: "builtin", label: "Builtin" },
					preferredApis: ["openai-responses"],
					apis: {
						"openai-completions": {
							compat: { supportsStore: true, thinkingFormat: "openai" },
							thinkingLevelMap: { low: "low", high: "high" },
						},
					},
				},
			],
		});
		const file = compile({
			version: 1,
			families: [
				{
					id: "file-family",
					match: { prefixes: ["foo-"] },
					metadata: { contextWindow: 30_000, cost: { input: 3 } },
					group: { id: "file", label: "File" },
					preferredApis: ["openai-completions"],
					apis: {
						"openai-completions": {
							compat: { supportsStore: false },
							thinkingLevelMap: { low: null, max: "max" },
						},
					},
				},
			],
		});

		expect(lookupCompatOverlay([builtin, file], "foo-1", "openai-completions")).toEqual({
			metadata: {
				reasoning: true,
				contextWindow: 30_000,
				cost: { input: 3, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			},
			group: { id: "file", label: "File" },
			preferredApis: ["openai-completions"],
			compat: { supportsStore: false, thinkingFormat: "openai" },
			thinkingLevelMap: { low: null, high: "high", max: "max" },
		});
	});

	it("deep-merges partial model metadata and replaces cost tiers as a whole", () => {
		const lower = compile({
			version: 1,
			families: [],
			models: [
				{
					id: "priced-model",
					metadata: {
						name: "Priced",
						cost: {
							input: 1,
							output: 2,
							tiers: [{ input: 3, output: 4, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 1000 }],
						},
					},
				},
			],
		});
		const higher = compile({
			version: 1,
			families: [],
			models: [
				{
					id: "priced-model",
					metadata: {
						cost: {
							input: 5,
							tiers: [{ input: 6, output: 7, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 2000 }],
						},
					},
				},
			],
		});

		expect(lookupModelCompatOverlay([lower, higher], "priced-model")?.metadata).toEqual({
			name: "Priced",
			cost: {
				input: 5,
				output: 2,
				tiers: [{ input: 6, output: 7, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 2000 }],
			},
		});
	});

	it("keeps API overlays isolated", () => {
		const registry = compile({
			version: 1,
			families: [],
			models: [
				{
					id: "multi-api",
					apis: {
						"openai-completions": {
							compat: { thinkingFormat: "deepseek" },
							thinkingLevelMap: { high: "high" },
						},
						"openai-responses": {
							compat: { supportsToolSearch: true },
							thinkingLevelMap: { max: "xhigh" },
						},
						"openai-codex-responses": {
							compat: { supportsDeveloperRole: false },
						},
						"mistral-conversations": { thinkingLevelMap: { low: "low" } },
						"google-generative-ai": { thinkingLevelMap: { high: "high" } },
						"google-vertex": { thinkingLevelMap: { max: "max" } },
					},
				},
			],
		});

		expect(lookupCompatOverlay([registry], "multi-api", "openai-completions")?.compat).toEqual({
			thinkingFormat: "deepseek",
		});
		expect(lookupCompatOverlay([registry], "multi-api", "openai-responses")?.compat).toEqual({
			supportsToolSearch: true,
		});
		expect(lookupCompatOverlay([registry], "multi-api", "openai-codex-responses")?.compat).toEqual({
			supportsDeveloperRole: false,
		});
		expect(lookupCompatOverlay([registry], "multi-api", "mistral-conversations")?.thinkingLevelMap).toEqual({
			low: "low",
		});
		expect(lookupCompatOverlay([registry], "multi-api", "google-generative-ai")?.thinkingLevelMap).toEqual({
			high: "high",
		});
		expect(lookupCompatOverlay([registry], "multi-api", "google-vertex")?.thinkingLevelMap).toEqual({
			max: "max",
		});
		expect(lookupCompatOverlay([registry], "multi-api", "anthropic-messages")?.compat).toBeUndefined();
	});

	it("replaces group and preferred APIs from exact and later source overlays", () => {
		const source = compile({
			version: 1,
			families: [
				{
					id: "family",
					match: { prefixes: ["foo-"] },
					group: { id: "family", label: "Family" },
					preferredApis: ["openai-responses", "openai-completions"],
				},
			],
			models: [
				{
					id: "foo-1",
					group: { id: "exact", label: "Exact" },
					preferredApis: ["anthropic-messages"],
				},
			],
		});
		const file = compile({
			version: 1,
			families: [{ id: "file", match: { prefixes: ["foo-"] }, preferredApis: [] }],
		});

		expect(lookupModelCompatOverlay([source], "foo-1")?.group).toEqual({ id: "exact", label: "Exact" });
		expect(lookupModelCompatOverlay([source], "foo-1")?.preferredApis).toEqual(["anthropic-messages"]);
		expect(lookupModelCompatOverlay([source, file], "foo-1")?.preferredApis).toEqual([]);
	});

	it("matches canonical IDs, aliases, and prefixes case-insensitively without fuzzy prefix expansion", () => {
		const registry = compile({
			version: 1,
			families: [
				{
					id: "deepseek-v4",
					match: { ids: ["deepseek-v4"], prefixes: ["deepseek-v4-"] },
					metadata: { reasoning: true },
				},
			],
			models: [{ id: "canonical-model", aliases: ["vendor/alias-model"], metadata: { vision: true } }],
		});

		expect(lookupModelCompatOverlay([registry], "DEEPSEEK-V4-PRO")?.metadata?.reasoning).toBe(true);
		expect(lookupModelCompatOverlay([registry], "deepseek-v4")?.metadata?.reasoning).toBe(true);
		expect(lookupModelCompatOverlay([registry], "deepseek-v40-pro")).toBeUndefined();
		expect(lookupModelCompatOverlay([registry], "VENDOR/ALIAS-MODEL")?.metadata?.vision).toBe(true);
	});

	it("returns undefined for no source or no match", () => {
		expect(lookupModelCompatOverlay([], "unknown")).toBeUndefined();
		expect(lookupModelCompatOverlay([BUILTIN_COMPAT_REGISTRY], "unknown")).toBeUndefined();
	});
});

describe("compat registry validation", () => {
	it("returns structured issues and throws a typed error", () => {
		const value = { version: 2, families: [] };
		const result = validateCompatRegistry(value);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/version" })]));
		}
		expect(() => compileCompatRegistry(value)).toThrow(CompatRegistryValidationError);
	});

	it.each([
		["unknown top-level field", { version: 1, families: [], typo: true }],
		["invalid families shape", { version: 1, families: {} }],
		["empty matcher", { version: 1, families: [{ id: "f", match: {} }] }],
		[
			"compat field on the wrong API",
			{
				version: 1,
				families: [
					{
						id: "f",
						match: { prefixes: ["f-"] },
						apis: { "openai-responses": { compat: { thinkingFormat: "deepseek" } } },
					},
				],
			},
		],
		[
			"compat on a map-only API",
			{
				version: 1,
				families: [
					{
						id: "f",
						match: { prefixes: ["f-"] },
						apis: { "mistral-conversations": { compat: { supportsDeveloperRole: true } } },
					},
				],
			},
		],
		[
			"unknown thinking level",
			{
				version: 1,
				families: [
					{
						id: "f",
						match: { prefixes: ["f-"] },
						apis: { "openai-completions": { thinkingLevelMap: { ultra: "ultra" } } },
					},
				],
			},
		],
		[
			"invalid thinking value",
			{
				version: 1,
				families: [
					{
						id: "f",
						match: { prefixes: ["f-"] },
						apis: { "openai-completions": { thinkingLevelMap: { high: false } } },
					},
				],
			},
		],
		[
			"negative cost",
			{
				version: 1,
				families: [],
				models: [{ id: "f", metadata: { cost: { input: -1 } } }],
			},
		],
		[
			"zero context window",
			{
				version: 1,
				families: [],
				models: [{ id: "f", metadata: { contextWindow: 0 } }],
			},
		],
	])("rejects %s", (_name, value) => {
		expect(validateCompatRegistry(value).success).toBe(false);
	});

	it("rejects case-insensitive duplicate model aliases and family IDs", () => {
		const result = validateCompatRegistry({
			version: 1,
			families: [
				{ id: "Family", match: { prefixes: ["a-"] } },
				{ id: "family", match: { prefixes: ["b-"] } },
			],
			models: [
				{ id: "model-a", aliases: ["alias"] },
				{ id: "model-b", aliases: ["ALIAS"] },
			],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues).toHaveLength(2);
		}
	});

	it("accepts null thinking levels and zero cost rates", () => {
		expect(
			validateCompatRegistry({
				version: 1,
				families: [],
				models: [
					{
						id: "valid",
						metadata: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
						apis: { "openai-completions": { thinkingLevelMap: { high: null } } },
					},
				],
			}).success,
		).toBe(true);
	});
});
