import { describe, expect, it } from "vitest";
import { clearModelsDevCache, enrichWithModelsDev } from "../../src/core/model-metadata.ts";

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
