import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
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
	}
	return { default: FakeOpenAI };
});

function completionsModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { ...baseModel, api: "openai-completions" } as const;
}

describe("openai-completions tool_choice", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("forwards toolChoice from simple options when tools are provided", async () => {
		const model = completionsModel();
		await streamOpenAICompletions(
			model,
			{
				messages: [{ role: "user", content: "Call ping with ok=true", timestamp: Date.now() }],
				tools: [
					{
						name: "ping",
						description: "Ping tool",
						parameters: {
							type: "object",
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						} as never,
					},
				],
			},
			{
				apiKey: "test",
				toolChoice: "required",
			} as unknown as SimpleStreamOptions,
		).result();

		const params = mockState.lastParams as { tool_choice?: string; tools?: unknown[] };
		expect(params.tool_choice).toBe("required");
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools?.length ?? 0).toBeGreaterThan(0);
	});

	it("omits toolChoice when no tools are provided", async () => {
		const model = completionsModel();
		await streamOpenAICompletions(
			model,
			{
				messages: [{ role: "user", content: "Summarize the conversation", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				toolChoice: "none",
			} as unknown as SimpleStreamOptions,
		).result();

		const params = mockState.lastParams as { tool_choice?: string; tools?: unknown[] };
		expect(params).not.toHaveProperty("tool_choice");
		expect(params).not.toHaveProperty("tools");
	});
});
