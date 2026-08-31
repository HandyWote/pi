import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelsDevCache, enrichWithModelsDev, mergeProfileModels } from "../../src/core/model-metadata.ts";
import type { UserModel } from "../../src/core/profiles-types.ts";

function makeModel(overrides: Partial<UserModel> & Pick<UserModel, "id">): UserModel {
	const { id, ...rest } = overrides;
	return {
		id,
		name: overrides.name ?? id,
		enabled: overrides.enabled ?? true,
		contextWindow: overrides.contextWindow ?? 128_000,
		maxTokens: overrides.maxTokens ?? 16_384,
		supportsReasoning: overrides.supportsReasoning ?? false,
		supportsVision: overrides.supportsVision ?? false,
		supportsToolCall: overrides.supportsToolCall ?? true,
		metadataSource: overrides.metadataSource ?? "official",
		...rest,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	clearModelsDevCache();
});

describe("enrichWithModelsDev", () => {
	it("returns defaults and a UI-only group when models.dev is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const result = await enrichWithModelsDev([{ id: "qwen-test", name: "Qwen Test" }]);
		expect(result[0]).toMatchObject({
			id: "qwen-test",
			metadataSource: "default",
			contextWindow: 128_000,
			supportsReasoning: false,
			supportsToolCall: true,
			group: { id: "qwen", label: "Qwen" },
			available: true,
		});
	});

	it("reads cost and capabilities from models.dev", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-test": {
										name: "GPT Test",
										reasoning: true,
										attachment: true,
										tool_call: true,
										limit: { context: 200_000, output: 32_000 },
										cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
									},
								},
							},
						}),
						{ status: 200 },
					),
			),
		);
		const result = await enrichWithModelsDev([{ id: "gpt-test", name: "gpt-test" }]);
		expect(result[0]).toMatchObject({
			name: "GPT Test",
			contextWindow: 200_000,
			maxTokens: 32_000,
			supportsReasoning: true,
			supportsVision: true,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		});
	});

	it("derives thinkingLevelMap from the official provider's effort options", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							deepseek: {
								models: {
									"deepseek-v4-pro": {
										name: "DeepSeek V4 Pro",
										reasoning: true,
										reasoning_options: [{ type: "effort", values: ["high", "max"] }],
									},
								},
							},
							"community-provider": {
								models: {
									"deepseek-v4-pro": {
										name: "DeepSeek V4 Pro",
										reasoning_options: [{ type: "effort", values: ["low", "high"] }],
									},
								},
							},
						}),
						{ status: 200 },
					),
			),
		);
		const result = await enrichWithModelsDev([{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }]);
		expect(result[0].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("maps none to off and drops unsupported effort levels", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-test": {
										name: "GPT Test",
										reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
									},
								},
							},
						}),
						{ status: 200 },
					),
			),
		);
		const result = await enrichWithModelsDev([{ id: "gpt-test", name: "gpt-test" }]);
		expect(result[0].thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("prefers a discovery-derived thinkingLevelMap over models.dev effort options", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							deepseek: {
								models: {
									"deepseek-v4-pro": {
										name: "DeepSeek V4 Pro",
										reasoning_options: [{ type: "effort", values: ["high", "max"] }],
									},
								},
							},
						}),
						{ status: 200 },
					),
			),
		);
		const result = await enrichWithModelsDev([
			{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: null,
				},
			},
		]);
		expect(result[0].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("leaves thinkingLevelMap unset when only toggle reasoning options exist", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-test": {
										name: "GPT Test",
										reasoning: true,
										reasoning_options: [{ type: "toggle" }],
									},
								},
							},
						}),
						{ status: 200 },
					),
			),
		);
		const result = await enrichWithModelsDev([{ id: "gpt-test", name: "gpt-test" }]);
		expect(result[0].thinkingLevelMap).toBeUndefined();
	});
});

describe("mergeProfileModels", () => {
	it("disables new models and marks missing models unavailable", () => {
		const existing = makeModel({ id: "missing", enabled: true, apiPreference: "anthropic-messages" });
		const enriched = makeModel({ id: "new-model", enabled: true, available: true });
		const result = mergeProfileModels([existing], [enriched], "2026-01-02T00:00:00.000Z");
		expect(result).toEqual([
			{ ...enriched, enabled: false, available: true, lastSeenAt: "2026-01-02T00:00:00.000Z" },
			{ ...existing, available: false },
		]);
	});

	it("refreshes discovered fields while preserving user intent field by field", () => {
		const existing = makeModel({
			id: "known",
			name: "Old",
			enabled: false,
			metadataSource: "community",
			apiPreference: "openai-responses",
			overrides: { name: "My name", maxTokens: 12_345 },
		});
		const enriched = makeModel({
			id: "known",
			name: "New",
			enabled: true,
			contextWindow: 200_000,
			metadataSource: "official",
			availableApis: ["openai-completions", "openai-responses"],
		});
		const result = mergeProfileModels([existing], [enriched], "seen");
		expect(result[0]).toEqual({
			...enriched,
			enabled: false,
			available: true,
			lastSeenAt: "seen",
			apiPreference: "openai-responses",
			overrides: { name: "My name", maxTokens: 12_345 },
		});
	});

	it("migrates legacy all-manual metadata into explicit overrides", () => {
		const existing = makeModel({
			id: "manual",
			name: "Custom name",
			enabled: false,
			contextWindow: 42_000,
			metadataSource: "manual",
		});
		const enriched = makeModel({ id: "manual", name: "Remote", contextWindow: 200_000 });
		const result = mergeProfileModels([existing], [enriched], "seen");
		expect(result[0].overrides).toMatchObject({ name: "Custom name", contextWindow: 42_000 });
		expect(result[0]).toMatchObject({ name: "Remote", contextWindow: 200_000, enabled: false });
	});
});
