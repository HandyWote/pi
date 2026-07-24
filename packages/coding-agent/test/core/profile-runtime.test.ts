import { compileCompatRegistry, type Model } from "@handy_wote/pi-ai";
import { describe, expect, it } from "vitest";
import { createProfileProvider } from "../../src/core/profile-runtime.ts";
import type { Profile, UserModel } from "../../src/core/profiles-types.ts";

function userModel(id: string, overrides: Partial<UserModel> = {}): UserModel {
	return {
		id,
		name: id,
		enabled: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		supportsReasoning: false,
		supportsVision: false,
		supportsToolCall: true,
		metadataSource: "default",
		available: true,
		...overrides,
	};
}

function profile(models: UserModel[]): Profile {
	return {
		id: "test-profile",
		name: "Test",
		baseUrl: "https://gateway.example.com/v1",
		apiKey: "sk-test",
		models,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("createProfileProvider", () => {
	it("keeps mixed APIs in one Profile provider", () => {
		const provider = createProfileProvider({
			...profile([
				userModel("gpt-test", { apiPreference: "openai-responses" }),
				userModel("claude-test", { apiPreference: "anthropic-messages" }),
				userModel("deepseek-test", { apiPreference: "openai-completions" }),
			]),
			apiRoutes: {
				"openai-responses": { sdkBaseUrl: "https://gateway.example.com/v1" },
				"anthropic-messages": { sdkBaseUrl: "https://gateway.example.com" },
				"openai-completions": { sdkBaseUrl: "https://gateway.example.com/v1" },
			},
		});
		expect(provider.id).toBe("test-profile");
		expect(provider.getModels().map((model) => [model.id, model.api, model.baseUrl])).toEqual([
			["gpt-test", "openai-responses", "https://gateway.example.com/v1"],
			["claude-test", "anthropic-messages", "https://gateway.example.com"],
			["deepseek-test", "openai-completions", "https://gateway.example.com/v1"],
		]);
	});

	it("falls back to the legacy profile base URL when no API route is stored", () => {
		const provider = createProfileProvider(profile([userModel("legacy", { apiPreference: "openai-completions" })]));
		expect(provider.getModels()[0]?.baseUrl).toBe("https://gateway.example.com/v1");
	});

	it("applies models.dev base, registry metadata/API overlay, then manual fields", () => {
		const registry = compileCompatRegistry({
			version: 1,
			families: [
				{
					id: "deepseek-test",
					match: { ids: ["deepseek-test"] },
					metadata: {
						reasoning: true,
						contextWindow: 200_000,
						maxTokens: 64_000,
						cost: { input: 1, output: 2 },
					},
					apis: {
						"openai-completions": {
							compat: {
								thinkingFormat: "deepseek",
								requiresReasoningContentOnAssistantMessages: true,
							},
							thinkingLevelMap: { low: null, high: "high" },
						},
					},
				},
			],
		});
		const source = userModel("deepseek-test", {
			apiPreference: "openai-completions",
			cost: { input: 0.5, output: 0.5, cacheRead: 0.1, cacheWrite: 0.2 },
			overrides: {
				maxTokens: 32_000,
				cost: { output: 3 },
				apis: {
					"openai-completions": {
						compat: { thinkingFormat: "zai" },
						thinkingLevelMap: { high: "custom" },
					},
				},
			},
		});
		const model = createProfileProvider(profile([source]), [registry]).getModels()[0] as Model<"openai-completions">;

		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(200_000);
		expect(model.maxTokens).toBe(32_000);
		expect(model.cost).toEqual({ input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0.2 });
		expect(model.compat).toMatchObject({
			supportsDeveloperRole: false,
			thinkingFormat: "zai",
			requiresReasoningContentOnAssistantMessages: true,
		});
		expect(model.thinkingLevelMap).toEqual({ low: null, high: "custom" });
	});

	it("does not let UI-only fuzzy groups activate registry compat", () => {
		const registry = compileCompatRegistry({
			version: 1,
			families: [
				{
					id: "deepseek",
					match: { prefixes: ["deepseek-"] },
					apis: { "openai-completions": { compat: { thinkingFormat: "deepseek" } } },
				},
			],
		});
		const model = createProfileProvider(
			profile([
				userModel("unknown-model", {
					name: "DeepSeek looking display name",
					group: { id: "deepseek", label: "DeepSeek" },
					apiPreference: "openai-completions",
				}),
			]),
			[registry],
		).getModels()[0] as Model<"openai-completions">;
		expect(model.compat).toEqual({ supportsDeveloperRole: false });
	});

	it("keeps unavailable models in settings but out of the runtime provider", () => {
		const provider = createProfileProvider(
			profile([
				userModel("available", { apiPreference: "openai-completions" }),
				userModel("missing", { apiPreference: "openai-completions", available: false }),
			]),
		);
		expect(provider.getModels().map((model) => model.id)).toEqual(["available"]);
	});

	it("fails clearly when an enabled model cannot resolve an API", () => {
		expect(() => createProfileProvider(profile([userModel("ambiguous")]))).toThrow("No supported API was discovered");
	});
});
