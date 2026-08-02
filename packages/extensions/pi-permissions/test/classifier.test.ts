import type { ExtensionContext, ModelRegistry } from "@handy_wote/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createClassifier } from "../src/classifier.ts";
import type { ToolCallInfo } from "../src/tool-input.ts";

function bashInfo(command: string): ToolCallInfo {
	return { toolName: "bash", command, paths: [], description: command };
}

function anthropicModel(id = "claude-3-5-haiku-latest") {
	return {
		id,
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
	} as unknown as NonNullable<ExtensionContext["model"]>;
}

function openaiModel() {
	return { id: "gpt-4o", api: "openai-responses", baseUrl: "https://api.openai.com" } as unknown as NonNullable<
		ExtensionContext["model"]
	>;
}

function ctxWith(options: {
	model: unknown;
	auth?: { ok: true; apiKey: string } | { ok: false; error: string };
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): { ctx: ExtensionContext; classify: ReturnType<typeof createClassifier> } {
	const registry = {
		getApiKeyAndHeaders: async () => options.auth ?? { ok: true, apiKey: "sk-test" },
	} as unknown as ModelRegistry;
	const ctx = { model: options.model, modelRegistry: registry } as unknown as ExtensionContext;
	const classify = createClassifier({
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs ?? 5000,
	});
	return { ctx, classify };
}

function okResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as unknown as Response;
}

describe("classifier", () => {
	it("returns undefined without a model", async () => {
		const { ctx, classify } = ctxWith({ model: undefined });
		expect(await classify(bashInfo("ls"), ctx)).toBeUndefined();
	});

	it("returns undefined for non-anthropic models", async () => {
		const { ctx, classify } = ctxWith({ model: openaiModel() });
		expect(await classify(bashInfo("ls"), ctx)).toBeUndefined();
	});

	it("blocks when no API key is available", async () => {
		const { ctx, classify } = ctxWith({
			model: anthropicModel(),
			auth: { ok: false, error: "no key" },
		});
		const result = await classify(bashInfo("ls"), ctx);
		expect(result?.block).toBe(true);
	});

	it("allows when the model says allow", async () => {
		const fetchImpl = (async () =>
			okResponse({ content: [{ text: '{"block": false, "reason": "safe"}' }] })) as typeof fetch;
		const { ctx, classify } = ctxWith({ model: anthropicModel(), fetchImpl });
		const result = await classify(bashInfo("git status"), ctx);
		expect(result).toEqual({ block: false, reason: "auto-mode classifier allowed" });
	});

	it("blocks when the model says block", async () => {
		const fetchImpl = (async () =>
			okResponse({ content: [{ text: '{"block": true, "reason": "deletes data"}' }] })) as typeof fetch;
		const { ctx, classify } = ctxWith({ model: anthropicModel(), fetchImpl });
		const result = await classify(bashInfo("rm -rf /"), ctx);
		expect(result).toEqual({ block: true, reason: "deletes data" });
	});

	it("blocks on HTTP errors (fail closed)", async () => {
		const fetchImpl = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
		const { ctx, classify } = ctxWith({ model: anthropicModel(), fetchImpl });
		const result = await classify(bashInfo("ls"), ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HTTP 500");
	});

	it("blocks on malformed responses (fail closed)", async () => {
		const fetchImpl = (async () => okResponse({ content: [{ text: "not json" }] })) as typeof fetch;
		const { ctx, classify } = ctxWith({ model: anthropicModel(), fetchImpl });
		const result = await classify(bashInfo("ls"), ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("malformed");
	});

	it("blocks when fetch throws (fail closed)", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const { ctx, classify } = ctxWith({ model: anthropicModel(), fetchImpl });
		const result = await classify(bashInfo("ls"), ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("network down");
	});

	it("blocks on timeout (fail closed)", async () => {
		const fetchImpl = (async () => new Promise<Response>(() => {})) as typeof fetch; // never resolves
		const { ctx, classify } = ctxWith({ model: anthropicModel(), fetchImpl, timeoutMs: 50 });
		const result = await classify(bashInfo("ls"), ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("timed out");
	});

	it("sends the command with the anthropic headers", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			captured = { url: String(url), init: init ?? {} };
			return okResponse({ content: [{ text: '{"block": false, "reason": "safe"}' }] });
		}) as typeof fetch;
		const { ctx, classify } = ctxWith({ model: anthropicModel("claude-test"), fetchImpl });
		await classify(bashInfo("git status"), ctx);
		const body = JSON.parse(String(captured?.init.body)) as { model: string; messages: { content: string }[] };
		expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(body.model).toBe("claude-test");
		expect(body.messages[0]?.content).toContain("git status");
		const headers = captured?.init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("sk-test");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
	});
});
