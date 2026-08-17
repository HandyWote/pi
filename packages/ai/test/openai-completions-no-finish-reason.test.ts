import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

function buildModel(baseUrl: string, compat?: OpenAICompletionsCompat): Model<"openai-completions"> {
	return {
		id: "custom-model",
		name: "Custom Model",
		api: "openai-completions",
		provider: "unself",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(compat ? { compat } : {}),
	};
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function createStreamingServer(chunks: Array<Record<string, unknown>>) {
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		for await (const _chunk of req) {
			// drain
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const chunk of chunks) {
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
	return server;
}

describe("openai-completions streams without finish_reason", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("infers stop when the provider omits finish_reason and supportsFinishReason is false", async () => {
		const server = createStreamingServer([
			{
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 0,
				model: "custom-model",
				choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
			},
		]);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = buildModel(`http://127.0.0.1:${port}`, { supportsFinishReason: false });

			const events = await collectEvents(streamOpenAICompletions(model, buildContext(), { apiKey: "test-key" }));

			const terminalEvent = events.at(-1);
			expect(terminalEvent?.type).toBe("done");
			if (terminalEvent?.type === "done") {
				expect(terminalEvent.reason).toBe("stop");
				expect(terminalEvent.message.content).toEqual([{ type: "text", text: "hello" }]);
			}
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("infers toolUse when the provider omits finish_reason and a tool call was streamed", async () => {
		const server = createStreamingServer([
			{
				id: "chatcmpl-2",
				object: "chat.completion.chunk",
				created: 0,
				model: "custom-model",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-2",
				object: "chat.completion.chunk",
				created: 0,
				model: "custom-model",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
						finish_reason: null,
					},
				],
			},
		]);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = buildModel(`http://127.0.0.1:${port}`, { supportsFinishReason: false });

			const events = await collectEvents(streamOpenAICompletions(model, buildContext(), { apiKey: "test-key" }));

			const terminalEvent = events.at(-1);
			expect(terminalEvent?.type).toBe("done");
			if (terminalEvent?.type === "done") {
				expect(terminalEvent.reason).toBe("toolUse");
				expect(terminalEvent.message.content).toEqual([
					{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
				]);
			}
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("still errors without finish_reason when supportsFinishReason is true", async () => {
		const server = createStreamingServer([
			{
				id: "chatcmpl-3",
				object: "chat.completion.chunk",
				created: 0,
				model: "custom-model",
				choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
			},
		]);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = buildModel(`http://127.0.0.1:${port}`);

			const events = await collectEvents(streamOpenAICompletions(model, buildContext(), { apiKey: "test-key" }));

			const terminalEvent = events.at(-1);
			expect(terminalEvent?.type).toBe("error");
			if (terminalEvent?.type === "error") {
				expect(terminalEvent.error.errorMessage).toContain("Stream ended without finish_reason");
			}
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
