import { describe, expect, it } from "vitest";
import {
	buildManualProtocolRoute,
	buildProtocolRoutes,
	normalizeProfileRootUrl,
	validateAutomaticProfileRootUrl,
} from "../../src/core/profile-endpoints.ts";

describe("profile endpoint routes", () => {
	it("builds the DeepSeek Anthropic-shaped routes from a protocol root", () => {
		const routes = buildProtocolRoutes("https://api.deepseek.com/anthropic");
		expect(routes).toEqual([
			expect.objectContaining({
				api: "openai-completions",
				catalogUrl: "https://api.deepseek.com/anthropic/v1/models",
				inferenceUrl: "https://api.deepseek.com/anthropic/v1/chat/completions",
				sdkBaseUrl: "https://api.deepseek.com/anthropic/v1",
				authStyle: "openai",
			}),
			expect.objectContaining({
				api: "openai-responses",
				catalogUrl: "https://api.deepseek.com/anthropic/v1/models",
				inferenceUrl: "https://api.deepseek.com/anthropic/v1/responses",
				sdkBaseUrl: "https://api.deepseek.com/anthropic/v1",
				authStyle: "openai",
			}),
			expect.objectContaining({
				api: "anthropic-messages",
				catalogUrl: "https://api.deepseek.com/anthropic/v1/models",
				inferenceUrl: "https://api.deepseek.com/anthropic/v1/messages",
				sdkBaseUrl: "https://api.deepseek.com/anthropic",
				authStyle: "anthropic",
			}),
		]);
	});

	it("uses /v1 for OpenAI SDKs but keeps the Anthropic SDK at the root", () => {
		const routes = buildProtocolRoutes("https://api.unself.cn");
		expect(routes.find((route) => route.api === "openai-completions")?.sdkBaseUrl).toBe("https://api.unself.cn/v1");
		expect(routes.find((route) => route.api === "openai-responses")?.sdkBaseUrl).toBe("https://api.unself.cn/v1");
		expect(routes.find((route) => route.api === "anthropic-messages")?.sdkBaseUrl).toBe("https://api.unself.cn");
		expect(routes.find((route) => route.api === "anthropic-messages")?.inferenceUrl).toBe(
			"https://api.unself.cn/v1/messages",
		);
	});

	it("preserves path prefixes, query strings, ports and IPv6 hosts", () => {
		const root = "https://[2001:db8::1]:8443/team-a///?tenant=one";
		expect(normalizeProfileRootUrl(root)).toBe("https://[2001:db8::1]:8443/team-a?tenant=one");
		const routes = buildProtocolRoutes(root);
		const routeKeys = routes.map((route) =>
			[route.api, route.catalogUrl, route.inferenceUrl, route.sdkBaseUrl, route.authStyle].join("\u0000"),
		);
		expect(new Set(routeKeys).size).toBe(routes.length);
		expect(routes[0]).toMatchObject({
			catalogUrl: "https://[2001:db8::1]:8443/team-a/v1/models?tenant=one",
			inferenceUrl: "https://[2001:db8::1]:8443/team-a/v1/chat/completions?tenant=one",
			sdkBaseUrl: "https://[2001:db8::1]:8443/team-a/v1?tenant=one",
		});
		expect(new Set(routes.map((route) => new URL(route.catalogUrl).origin))).toEqual(
			new Set(["https://[2001:db8::1]:8443"]),
		);
	});

	it("normalizes trailing slashes without changing the root query", () => {
		expect(normalizeProfileRootUrl("https://gateway.example///?region=us")).toBe("https://gateway.example?region=us");
		expect(validateAutomaticProfileRootUrl("https://gateway.example/tenant///")).toBe(
			"https://gateway.example/tenant",
		);
	});

	it("rejects unsupported schemes and credentials", () => {
		expect(() => normalizeProfileRootUrl("ftp://gateway.example")).toThrow("http or https");
		expect(() => normalizeProfileRootUrl("https://user:pass@gateway.example")).toThrow("username or password");
	});

	it("rejects known resource tails in automatic mode", () => {
		for (const suffix of [
			"/v1",
			"/v1beta/",
			"/models",
			"/messages",
			"/responses",
			"/chat/completions",
			"/conversations",
		]) {
			expect(() => validateAutomaticProfileRootUrl(`https://gateway.example/team${suffix}`)).toThrow(
				"service root URL",
			);
		}
	});

	it("derives manual inference routes from serializer SDK bases", () => {
		expect(buildManualProtocolRoute("openai-completions", "https://gateway.example/openai/v1")).toMatchObject({
			sdkBaseUrl: "https://gateway.example/openai/v1",
			catalogUrl: "https://gateway.example/openai/v1/models",
			inferenceUrl: "https://gateway.example/openai/v1/chat/completions",
		});
		expect(buildManualProtocolRoute("anthropic-messages", "https://gateway.example/anthropic")).toMatchObject({
			catalogUrl: "https://gateway.example/anthropic/v1/models",
			inferenceUrl: "https://gateway.example/anthropic/v1/messages",
		});
	});
});
