import { describe, expect, it } from "vitest";
import { clearModelsDevCache, enrichWithModelsDev, mergeProfileModels } from "../../src/core/model-metadata.ts";
import type { UserModel } from "../../src/core/profiles-types.ts";

function makeModel(overrides: Partial<UserModel> & Pick<UserModel, "id">): UserModel {
	return {
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		enabled: overrides.enabled ?? true,
		contextWindow: overrides.contextWindow ?? 128_000,
		maxTokens: overrides.maxTokens ?? 16_384,
		supportsReasoning: overrides.supportsReasoning ?? false,
		supportsVision: overrides.supportsVision ?? false,
		supportsToolCall: overrides.supportsToolCall ?? true,
		metadataSource: overrides.metadataSource ?? "official",
	};
}

describe("enrichWithModelsDev", () => {
	it("returns defaults when models.dev is unavailable", async () => {
		clearModelsDevCache();
		const result = await enrichWithModelsDev([{ id: "test-model", name: "Test Model" }]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("test-model");
		expect(result[0].metadataSource).toBe("manual");
		expect(result[0].contextWindow).toBe(128_000);
		expect(result[0].supportsReasoning).toBe(false);
		expect(result[0].supportsToolCall).toBe(true);
	});

	it("handles empty model list", async () => {
		clearModelsDevCache();
		const result = await enrichWithModelsDev([]);
		expect(result).toEqual([]);
	});
});

describe("mergeProfileModels", () => {
	it("disables newly discovered models", () => {
		const enriched = makeModel({ id: "new-model", enabled: true });

		expect(mergeProfileModels([], [enriched])).toEqual([{ ...enriched, enabled: false }]);
	});

	it("refreshes discovered metadata while preserving enabled state", () => {
		const existing = makeModel({ id: "known", name: "Old", enabled: false, metadataSource: "community" });
		const enriched = makeModel({
			id: "known",
			name: "New",
			enabled: true,
			contextWindow: 200_000,
			metadataSource: "official",
		});

		expect(mergeProfileModels([existing], [enriched])).toEqual([{ ...enriched, enabled: false }]);
	});

	it("preserves manual models without absorbing enriched metadata", () => {
		const existing = makeModel({
			id: "manual",
			name: "Custom name",
			enabled: false,
			contextWindow: 42_000,
			metadataSource: "manual",
		});
		const enriched = makeModel({
			id: "manual",
			name: "Remote name",
			enabled: true,
			contextWindow: 200_000,
			metadataSource: "official",
		});

		expect(mergeProfileModels([existing], [enriched])).toEqual([existing]);
	});
});
