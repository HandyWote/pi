import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

function buildModel(baseUrl: string, compat?: OpenAICompletionsCompat): Model<"openai-completions"> {
	return {
		id: "custom-model",
		name: "Custom Model",
		api: "openai-completions",
		provider: "unself",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(compat ? { compat } : {}),
	};
}

function buildAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "unself",
		model: "custom-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function buildContext(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

interface ChatCompletionsRequestBody {
	model: string;
	messages: Array<{ role: string; content?: unknown; reasoning_content?: string }>;
	stream: boolean;
	thinking?: { type: string };
	reasoning_effort?: string;
}

describe("openai-completions compat merge", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("prefers explicit model compat over provider and baseUrl detection", async () => {
		const requestBodies: ChatCompletionsRequestBody[] = [];
		const server = http.createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/chat/completions") {
				res.writeHead(404).end();
				return;
			}

			let body = "";
			for await (const chunk of req) {
				body += chunk.toString();
			}
			requestBodies.push(JSON.parse(body) as ChatCompletionsRequestBody);

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repro",
					object: "chat.completion.chunk",
					created: 0,
					model: "custom-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = buildModel(`http://127.0.0.1:${port}`, {
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: false,
			});

			const events = await collectEvents(
				streamOpenAICompletions(model, buildContext(buildAssistant([{ type: "text", text: "previous answer" }])), {
					apiKey: "test-key",
					reasoningEffort: "medium",
				}),
			);

			expect(requestBodies).toHaveLength(1);
			expect(requestBodies[0]?.thinking).toEqual({ type: "enabled" });
			expect(requestBodies[0]?.reasoning_effort).toBeUndefined();
			expect(requestBodies[0]?.messages[1]?.reasoning_content).toBe("");

			const terminalEvent = events.at(-1);
			expect(terminalEvent?.type).toBe("done");
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
