import { describe, expect, it, vi } from "vitest";
import { discoverProfile } from "../../src/core/profile-discovery.ts";
import type { Profile } from "../../src/core/profiles-types.ts";

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

describe("discoverProfile", () => {
	it("combines catalog declarations with non-generating endpoint probes", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			requests.push({ url, method });
			if (url.endsWith("/models")) {
				return new Response(
					JSON.stringify({
						supported_apis: ["openai-responses", "anthropic"],
						data: [
							{
								id: "claude-test",
								display_name: "Claude Test",
								supported_apis: ["anthropic-messages", "openai-completions"],
								preferred_api: "anthropic",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(null, { status: url.endsWith("/responses") ? 204 : 404 });
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch });
		expect(result.availableApis).toEqual(["openai-responses", "anthropic-messages"]);
		expect(result.models[0]).toMatchObject({
			id: "claude-test",
			name: "Claude Test",
			gatewayPreferredApi: "anthropic-messages",
			availableApis: ["anthropic-messages", "openai-completions"],
		});
		expect(
			requests
				.filter((request) => !request.url.endsWith("/models"))
				.every((request) => request.method === "OPTIONS"),
		).toBe(true);
	});

	it("falls back to Anthropic catalog authentication without sending a prompt", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			if (headers.has("Authorization")) return new Response(null, { status: 401 });
			return new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), { status: 200 });
		});
		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch, probeApis: false });
		expect(result.availableApis).toEqual([]);
		expect(result.warnings[0]).toContain("no generation API was confirmed");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not mix an explicit model preference into the discovery cache", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 }));
		const result = await discoverProfile(
			profile({
				models: [
					{
						id: "model-a",
						name: "Model A",
						enabled: true,
						contextWindow: 1,
						maxTokens: 1,
						supportsReasoning: false,
						supportsVision: false,
						supportsToolCall: true,
						metadataSource: "default",
						apiPreference: "openai-responses",
					},
				],
			}),
			{ fetch: fetchMock as typeof fetch, probeApis: false },
		);
		expect(result.models[0].availableApis).toEqual([]);
	});
});
