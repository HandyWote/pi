import { describe, expect, it } from "vitest";
import { getOpenRouterThinkingLevelMap } from "../../src/core/openrouter-reasoning-options.ts";

describe("getOpenRouterThinkingLevelMap", () => {
	it("marks mandatory reasoning and unsupported efforts unavailable", () => {
		expect(
			getOpenRouterThinkingLevelMap({
				mandatory: true,
				default_enabled: true,
				supported_efforts: ["max", "high", "low"],
				default_effort: "max",
			}),
		).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("still marks off unavailable when OpenRouter omits effort metadata", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: true })).toEqual({ off: null });
	});

	it("keeps off available while restricting optional models to supported efforts", () => {
		expect(
			getOpenRouterThinkingLevelMap({
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["high", "low"],
			}),
		).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("does not add metadata for optional models without effort controls", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: false })).toBeUndefined();
	});

	it("returns undefined for missing reasoning metadata", () => {
		expect(getOpenRouterThinkingLevelMap(undefined)).toBeUndefined();
	});
});
