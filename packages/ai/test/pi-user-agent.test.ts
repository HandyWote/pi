import { arch, platform, release } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamMistral } from "../src/api/mistral-conversations.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "../src/types.ts";

const PI_USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`;

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	mistralOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@mistralai/mistralai", () => {
	class FakeMistral {
		constructor(opts: Record<string, unknown>) {
			mockState.mistralOpts = opts;
		}
		chat = {
			stream: async () => {
				const chunks = [
					{
						data: {
							id: "resp",
							model: "test-model",
							choices: [{ index: 0, finish_reason: "stop", delta: {} }],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						},
					},
				];
				return (async function* () {
					for (const chunk of chunks) yield chunk;
				})();
			},
		};
	}
	return { Mistral: FakeMistral, HTTPClient: class HTTPClient {} };
});

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
		responses = {
			create: () => {
				const responseStream: AsyncIterable<unknown> = (async function* () {
					yield {
						type: "response.completed",
						sequence_number: 0,
						response: { id: "resp_1", status: "completed" },
					};
				})();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<unknown>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<unknown>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}
	return { default: FakeOpenAI, AzureOpenAI: FakeOpenAI };
});

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: () => {
				const body = [
					`event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
					})}\n`,
					`event: message_delta\ndata: ${JSON.stringify({
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: { output_tokens: 1 },
					})}\n`,
					`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
				].join("\n");
				return {
					asResponse: async () =>
						new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						}),
				};
			},
		};
	}
	return { default: FakeAnthropic };
});

function resetMocks(): void {
	mockState.constructorOpts = undefined;
	mockState.mistralOpts = undefined;
}

function createModel<TApi extends Api>(api: TApi, provider = "test-provider"): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider,
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("pi user-agent on API adapters", () => {
	it("openai-completions sends pi User-Agent by default", async () => {
		resetMocks();
		await streamOpenAICompletions(createModel("openai-completions"), context, { apiKey: "test" }).result();
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(headers["User-Agent"]).toBe(PI_USER_AGENT);
	});

	it("openai-responses sends pi User-Agent by default", async () => {
		resetMocks();
		await streamOpenAIResponses(createModel("openai-responses"), context, { apiKey: "test" }).result();
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(headers["User-Agent"]).toBe(PI_USER_AGENT);
	});

	it("azure-openai-responses sends pi User-Agent by default", async () => {
		resetMocks();
		await streamAzureOpenAIResponses(createModel("azure-openai-responses"), context, {
			apiKey: "test",
			azureBaseUrl: "https://my-resource.openai.azure.com",
		} as SimpleStreamOptions).result();
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(headers["User-Agent"]).toBe(PI_USER_AGENT);
	});

	it("anthropic-messages sends pi User-Agent by default", async () => {
		resetMocks();
		await streamAnthropic(createModel("anthropic-messages"), context, { apiKey: "test" }).result();
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(headers["User-Agent"]).toBe(PI_USER_AGENT);
	});

	it("lets explicit headers override the default User-Agent", async () => {
		resetMocks();
		await streamOpenAICompletions(createModel("openai-completions"), context, {
			apiKey: "test",
			headers: { "User-Agent": "custom-agent" },
		}).result();
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string>;
		expect(headers["User-Agent"]).toBe("custom-agent");
	});

	it("mistral-conversations passes pi User-Agent to the SDK client", async () => {
		resetMocks();
		await streamMistral(createModel("mistral-conversations"), context, { apiKey: "test" }).result();
		expect(mockState.mistralOpts?.userAgent).toBe(PI_USER_AGENT);
	});
});
