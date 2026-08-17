import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	stream as streamOpenAICompletions,
	streamSimple as streamSimpleOpenAICompletions,
} from "../src/api/openai-completions.ts";
import type { Api, Context, Model } from "../src/types.ts";

function createModel<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "custom-model",
		name: "Custom Model",
		api,
		provider: "unself",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<TApi>;
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
}

interface CapturedRequest {
	body: Record<string, unknown>;
}

function createCapturingServer(captured: CapturedRequest[]) {
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) {
			body += chunk.toString();
		}
		captured.push({ body: JSON.parse(body) as Record<string, unknown> });
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 0,
				model: "custom-model",
				choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});
	return server;
}

describe("generic sampling parameters", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("merges model and per-request samplingParams into completions request bodies", async () => {
		const captured: CapturedRequest[] = [];
		const server = createCapturingServer(captured);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = createModel("openai-completions", `http://127.0.0.1:${port}`);
			model.samplingParams = { top_k: 40, min_p: 0.05, repetition_penalty: 1.1 };

			const stream = streamSimpleOpenAICompletions(model, buildContext(), {
				apiKey: "test-key",
				temperature: 0.7,
				samplingParams: { min_p: 0.1, top_p: 0.9 },
			});
			const events = [];
			for await (const event of stream) {
				events.push(event.type);
			}

			expect(events.at(-1)).toBe("done");
			expect(captured).toHaveLength(1);
			const body = captured[0]!.body;
			expect(body.top_k).toBe(40);
			expect(body.min_p).toBe(0.1); // per-request wins over model default
			expect(body.top_p).toBe(0.9);
			expect(body.repetition_penalty).toBe(1.1);
			expect(body.temperature).toBe(0.7);
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("passes samplingParams through direct stream calls to the completions adapter", async () => {
		const captured: CapturedRequest[] = [];
		const server = createCapturingServer(captured);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = createModel("openai-completions", `http://127.0.0.1:${port}`);

			const stream = streamOpenAICompletions(model, buildContext(), {
				apiKey: "test-key",
				samplingParams: { top_k: 10, seed: 42 },
			});
			const events = [];
			for await (const event of stream) {
				events.push(event.type);
			}

			expect(events.at(-1)).toBe("done");
			expect(captured[0]!.body.top_k).toBe(10);
			expect(captured[0]!.body.seed).toBe(42);
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
