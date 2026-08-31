import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

const context: Context = {
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

afterEach(() => {
	mockState.constructorOpts = undefined;
	mockState.createParams = undefined;
});

describe("Anthropic refusal fallback", () => {
	it("adds the server-side fallback beta and forwards fallbacks in params", async () => {
		const message = await streamAnthropic(model, context, {
			apiKey: "anthropic-key",
			refusalFallbacks: [{ model: "claude-opus-4-8" }],
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(mockState.createParams).toMatchObject({ fallbacks: [{ model: "claude-opus-4-8" }] });
		const defaultHeaders = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(defaultHeaders["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
	});

	it("omits fallbacks and the beta when no refusal fallback is configured", async () => {
		await streamAnthropic(model, context, { apiKey: "anthropic-key" }).result();

		expect(mockState.createParams).not.toHaveProperty("fallbacks");
		const defaultHeaders = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(defaultHeaders["anthropic-beta"] ?? "").not.toContain("server-side-fallback-2026-07-01");
	});
});
