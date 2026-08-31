import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import type { Model } from "../src/types.ts";

vi.mock("openai", () => {
	class FakeAzureOpenAI {
		responses = {
			create: (_body: unknown, _options?: unknown) => {
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
	return { AzureOpenAI: FakeAzureOpenAI };
});

const model: Model<"azure-openai-responses"> = {
	id: "test-deployment",
	name: "Test Deployment",
	api: "azure-openai-responses",
	provider: "azure-openai-responses",
	baseUrl: "http://127.0.0.1:9/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

describe("Azure OpenAI tool choice", () => {
	it("forwards provider-specific tool choice while preserving tool definitions", async () => {
		let payload: unknown;
		const result = streamAzureOpenAIResponses(
			model,
			{
				messages: [{ role: "user", content: "Summarize this", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: Type.Object({ path: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				azureBaseUrl: "https://my-resource.openai.azure.com",
				toolChoice: "required",
				onPayload: (requestPayload) => {
					payload = requestPayload;
					throw new Error("payload captured");
				},
			},
		);

		await result.result();

		expect(payload).toMatchObject({ tool_choice: "required" });
		expect((payload as { tools?: unknown[] }).tools).toHaveLength(1);
	});
});
