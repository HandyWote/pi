import { describe, expect, it, vi } from "vitest";
import { discoverProfile, verifyProfileRoute } from "../../src/core/profile-discovery.ts";
import { buildManualProtocolRoute } from "../../src/core/profile-endpoints.ts";
import type { Profile } from "../../src/core/profiles-types.ts";

function profile(overrides: Partial<Profile> = {}): Profile {
	return {
		id: "profile-a",
		name: "Profile A",
		baseUrl: "https://gateway.example/team-a",
		apiKey: "secret-key",
		models: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function catalogResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function protocolError(status = 400): Response {
	return catalogResponse({ error: { type: "invalid_request_error", message: "a model is required" } }, status);
}

describe("discoverProfile", () => {
	it("deduplicates catalogs and verifies each route with POST {}", async () => {
		const requests: Array<{ url: string; method: string; body?: string; headers: Headers }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = {
				url: String(input),
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : undefined,
				headers: new Headers(init?.headers),
			};
			requests.push(request);
			if (request.url.endsWith("/v1/models")) {
				return catalogResponse({ data: [{ id: "model-a", name: "Model A" }] });
			}
			return protocolError();
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch });

		expect(result.failures).toEqual([]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			models: [
				{
					id: "model-a",
					name: "Model A",
					availableApis: ["openai-completions", "openai-responses", "anthropic-messages"],
				},
			],
			availableApis: ["openai-completions", "openai-responses", "anthropic-messages"],
		});
		expect(requests.filter((request) => request.url.endsWith("/v1/models"))).toHaveLength(2);
		expect(requests.filter((request) => request.method === "POST")).toHaveLength(3);
		expect(requests.every((request) => request.method !== "OPTIONS")).toBe(true);
		for (const request of requests.filter((item) => item.method === "POST")) {
			expect(request.body).toBe("{}");
			expect(request.body).not.toMatch(/model|messages|prompt|input|stream/);
		}
		const openAiCatalog = requests.find(
			(request) => request.method === "GET" && request.headers.has("authorization"),
		);
		const anthropicCatalog = requests.find((request) => request.method === "GET" && request.headers.has("x-api-key"));
		expect(openAiCatalog?.headers.get("authorization")).toBe("Bearer secret-key");
		expect(anthropicCatalog?.headers.get("x-api-key")).toBe("secret-key");
		expect(anthropicCatalog?.headers.get("anthropic-version")).toBe("2023-06-01");
	});

	it("uses declared APIs to exclude conflicting protocol routes", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, method: init?.method ?? "GET" });
			if (init?.method !== "POST") {
				return catalogResponse({
					supported_apis: ["openai-responses"],
					data: [{ id: "model-a" }],
				});
			}
			return protocolError();
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch });
		expect(result.failures).toEqual([]);
		expect(result.candidates[0]?.availableApis).toEqual(["openai-responses"]);
		expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
		expect(requests.find((request) => request.method === "POST")?.url).toBe(
			"https://gateway.example/team-a/v1/responses",
		);
	});

	it("follows one same-origin catalog redirect and refuses cross-origin redirects", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/v1/models")) {
				return new Response(null, { status: 302, headers: { location: "https://other.example/models" } });
			}
			if (url === "https://other.example/models") return catalogResponse({ data: [{ id: "unsafe" }] });
			return protocolError();
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch });
		expect(result.candidates).toEqual([]);
		expect(
			result.failures.some((failure) => failure.stage === "catalog" && failure.message.includes("cross-origin")),
		).toBe(true);
		expect(requestedUrls).not.toContain("https://other.example/models");
	});

	it("accepts only structured protocol errors for inference verification", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method !== "POST") return catalogResponse({ data: [{ id: "model-a" }] });
			if (url.endsWith("/chat/completions")) return catalogResponse({ error: "bad request" }, 400);
			if (url.endsWith("/responses")) return catalogResponse({ error: { code: "invalid_request" } }, 422);
			return catalogResponse({ error: { type: "invalid_request_error", message: "bad" } }, 429);
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch });
		expect(result.candidates[0]?.availableApis).toEqual(["openai-responses", "anthropic-messages"]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({ stage: "inference", route: { api: "openai-completions" } });
		expect(result.candidates[0]?.warnings).toContain(
			"anthropic-messages: inference route responded with a structured rate-limit error",
		);
	});

	it("derives thinkingLevelMap from OpenRouter-style reasoning metadata", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method !== "POST") {
				return catalogResponse({
					data: [
						{
							id: "model-or",
							name: "OpenRouter Model",
							reasoning: { mandatory: true, supported_efforts: ["high", "low"] },
						},
						{
							id: "model-plain",
							name: "Plain Model",
							reasoning: { mandatory: false },
						},
					],
				});
			}
			return protocolError();
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch, probeApis: false });
		expect(result.candidates[0]?.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "model-or",
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: "low",
						medium: null,
						high: "high",
						xhigh: null,
						max: null,
					},
				}),
				expect.objectContaining({ id: "model-plain" }),
			]),
		);
		expect(
			result.candidates[0]?.models.find((model) => model.id === "model-plain")?.thinkingLevelMap,
		).toBeUndefined();
	});

	it("retries hung catalog requests past the per-attempt timeout", async () => {
		const attemptsByUrl = new Map<string, number>();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method !== "POST") {
				const attempt = (attemptsByUrl.get(url) ?? 0) + 1;
				attemptsByUrl.set(url, attempt);
				if (attempt === 1) {
					// Simulate the per-attempt timeout aborting the hung request.
					init?.signal?.dispatchEvent(new Event("abort"));
					throw new DOMException("The operation was aborted.", "AbortError");
				}
				return catalogResponse({ data: [{ id: "model-a", name: "Model A" }] });
			}
			return protocolError();
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch });
		expect(result.failures).toEqual([]);
		expect(result.candidates[0]?.models[0]).toMatchObject({ id: "model-a" });
		for (const attempts of attemptsByUrl.values()) expect(attempts).toBeGreaterThan(1);
	});

	it("supports catalog-only diagnostics when explicitly requested", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.method ?? "GET").toBe("GET");
			return catalogResponse({ data: [{ id: "model-a" }] });
		});

		const result = await discoverProfile(profile(), { fetch: fetchMock as typeof fetch, probeApis: false });
		expect(result.failures).toEqual([]);
		expect(result.candidates[0]?.availableApis).toEqual([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
		]);
	});

	it("verifies a manual SDK route with an empty POST body", async () => {
		const requests: Array<{ url: string; method: string; body?: string }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			return protocolError();
		});
		const route = buildManualProtocolRoute("openai-completions", "https://gateway.example/openai/v1");
		const result = await verifyProfileRoute(profile(), route, { fetch: fetchMock as typeof fetch });
		expect(result.confirmed).toBe(true);
		expect(requests).toEqual([
			{ url: "https://gateway.example/openai/v1/chat/completions", method: "POST", body: "{}" },
		]);
	});
});
