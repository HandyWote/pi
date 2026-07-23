import { compileCompatRegistry } from "@handy_wote/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveProfileModelApi } from "../../src/core/profile-api-resolution.ts";
import type { Profile, UserModel } from "../../src/core/profiles-types.ts";

function model(overrides: Partial<UserModel> = {}): UserModel {
	return {
		id: "model-a",
		name: "Model A",
		enabled: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		supportsReasoning: false,
		supportsVision: false,
		supportsToolCall: true,
		metadataSource: "default",
		...overrides,
	};
}

function profile(overrides: Partial<Profile> = {}): Profile {
	return {
		id: "profile-a",
		name: "Profile A",
		baseUrl: "https://gateway.example/v1",
		apiKey: "key",
		models: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("resolveProfileModelApi", () => {
	it("uses model, family, gateway, registry, profile, then unique availability priority", () => {
		const registry = compileCompatRegistry({
			version: 1,
			families: [],
			models: [{ id: "model-a", preferredApis: ["anthropic-messages", "openai-responses"] }],
		});
		const baseProfile = profile({
			apiPreference: "openai-completions",
			familyApiPreferences: { family: "anthropic-messages" },
			availableApis: ["openai-completions", "openai-responses", "anthropic-messages"],
		});
		const baseModel = model({
			group: { id: "family", label: "Family" },
			gatewayPreferredApi: "openai-responses",
			availableApis: baseProfile.availableApis,
		});

		expect(resolveProfileModelApi(baseProfile, { ...baseModel, apiPreference: "openai-responses" }).source).toBe(
			"model",
		);
		expect(resolveProfileModelApi(baseProfile, baseModel).source).toBe("family");
		expect(
			resolveProfileModelApi({ ...baseProfile, familyApiPreferences: {} }, baseModel, {
				registrySources: [registry],
			}).source,
		).toBe("gateway");
		expect(
			resolveProfileModelApi(
				{ ...baseProfile, familyApiPreferences: {} },
				{ ...baseModel, gatewayPreferredApi: undefined },
				{ registrySources: [registry] },
			),
		).toMatchObject({ api: "anthropic-messages", source: "registry" });
		expect(
			resolveProfileModelApi(
				{ ...baseProfile, familyApiPreferences: {} },
				{ ...baseModel, id: "unknown", gatewayPreferredApi: undefined },
				{ registrySources: [registry] },
			).source,
		).toBe("profile");
		expect(
			resolveProfileModelApi(
				profile({ availableApis: ["openai-responses"] }),
				model({ availableApis: ["openai-responses"] }),
			).source,
		).toBe("available");
	});

	it("only selects registry native preferences that the gateway exposes", () => {
		const registry = compileCompatRegistry({
			version: 1,
			families: [],
			models: [{ id: "model-a", preferredApis: ["anthropic-messages", "openai-completions"] }],
		});
		const result = resolveProfileModelApi(profile(), model({ availableApis: ["openai-completions"] }), {
			registrySources: [registry],
		});
		expect(result).toMatchObject({ api: "openai-completions", source: "registry" });
	});

	it("does not silently replace an explicit API whose serializer is missing", () => {
		const result = resolveProfileModelApi(profile(), model({ apiPreference: "google-generative-ai" }));
		expect(result.api).toBeUndefined();
		expect(result.reason).toContain("serializer is not installed");
	});

	it("keeps existing protocol profiles working as an explicit legacy fallback", () => {
		expect(resolveProfileModelApi(profile({ protocol: "anthropic" }), model())).toMatchObject({
			api: "anthropic-messages",
			source: "legacy",
		});
	});

	it("reports unresolved when discovery is ambiguous", () => {
		const result = resolveProfileModelApi(
			profile({ availableApis: ["openai-completions", "openai-responses"] }),
			model(),
		);
		expect(result.source).toBe("unresolved");
		expect(result.reason).toContain("Multiple APIs");
	});
});
