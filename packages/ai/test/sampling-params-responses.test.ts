import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { streamSimple as streamSimpleOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (body: Record<string, unknown>) => {
				capturedResponsesBodies.push(body);
				const responseStream: AsyncIterable<ResponseStreamEvent> = (async function* () {
					yield {
						type: "response.completed",
						sequence_number: 0,
						response: {
							id: "resp_1",
							status: "completed",
							usage: {
								input_tokens: 20,
								output_tokens: 7,
								total_tokens: 27,
								input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
							},
						},
					} as unknown as ResponseStreamEvent;
				})();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
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

	return { default: FakeOpenAI };
});

const capturedResponsesBodies: Array<Record<string, unknown>> = [];

function createModel(): Model<"openai-responses"> {
	return {
		id: "custom-model",
		name: "Custom Model",
		api: "openai-responses",
		provider: "unself",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
}

describe("generic sampling parameters (responses adapter)", () => {
	it("merges samplingParams into responses adapter request bodies", async () => {
		const model = createModel();

		const stream = streamSimpleOpenAIResponses(model, buildContext(), {
			apiKey: "test-key",
			samplingParams: { top_k: 20, min_p: 0.2 },
		});
		const events = [];
		for await (const event of stream) {
			events.push(event.type);
		}

		expect(events.at(-1)).toBe("done");
		expect(capturedResponsesBodies).toHaveLength(1);
		expect(capturedResponsesBodies[0]!.top_k).toBe(20);
		expect(capturedResponsesBodies[0]!.min_p).toBe(0.2);
	});
});
