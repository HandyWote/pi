import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel } from "../src/compat.ts";
import type { Context, FetchFunction } from "../src/types.ts";

function createSseResponse(events: unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\r\n\r\n")}\r\n\r\ndata: [DONE]\r\n\r\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Mistral indexed tool call chunk merging", () => {
	it("merges fragmented tool call chunks keyed by index into a single block", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "lookup",
					description: "Look something up",
					parameters: Type.Object({ query: Type.String() }),
				},
			],
		};
		const events = [
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: null,
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { name: "lookup", arguments: '{"query":' },
								},
							],
						},
					},
				],
			},
			{
				id: "response-1",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: "tool_calls",
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { name: "", arguments: '"pi"}' },
								},
							],
						},
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 4,
					total_tokens: 14,
					prompt_tokens_details: { cached_tokens: 3 },
				},
			},
		];
		const fetch: FetchFunction = async () => createSseResponse(events);

		const message = await streamMistral(model, context, { apiKey: "test", fetch }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "toolCall", id: expect.any(String), name: "lookup", arguments: { query: "pi" } },
		]);
	});
});
