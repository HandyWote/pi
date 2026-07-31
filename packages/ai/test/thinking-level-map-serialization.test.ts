import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamMistralSimple } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type {
	Api,
	AssistantMessageEvent,
	Context,
	Model,
	OpenAICompletionsCompat,
	StreamOptions,
	ThinkingLevelMap,
} from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

class PayloadCaptured extends Error {}

function buildModel<TApi extends Api>(
	api: TApi,
	thinkingLevelMap?: ThinkingLevelMap,
	id = "reasoning-test",
): Model<TApi> {
	return {
		id,
		name: "Reasoning Test",
		api,
		provider: "custom-gateway",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function capturePayload(
	start: (onPayload: NonNullable<StreamOptions["onPayload"]>) => AsyncIterable<AssistantMessageEvent>,
): Promise<Record<string, unknown>> {
	let captured: unknown;
	const onPayload: NonNullable<StreamOptions["onPayload"]> = (payload) => {
		captured = payload;
		throw new PayloadCaptured();
	};
	for await (const _event of start(onPayload)) {
		// Drain the terminal error produced after capturing the request payload.
	}
	if (!captured || typeof captured !== "object") {
		throw new Error("Provider payload was not captured");
	}
	return captured as Record<string, unknown>;
}

function getNestedEffort(payload: Record<string, unknown>): string | undefined {
	const reasoning = payload.reasoning;
	if (!reasoning || typeof reasoning !== "object") return undefined;
	const effort = (reasoning as Record<string, unknown>).effort;
	return typeof effort === "string" ? effort : undefined;
}

type CompletionsThinkingFormat = NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;

const completionsFormats: Array<{
	format: CompletionsThinkingFormat;
	compat?: Pick<OpenAICompletionsCompat, "chatTemplateKwargs">;
	readValue: (payload: Record<string, unknown>) => string | undefined;
}> = [
	{ format: "openai", readValue: (payload) => payload.reasoning_effort as string | undefined },
	{ format: "deepseek", readValue: (payload) => payload.reasoning_effort as string | undefined },
	{ format: "zai", readValue: (payload) => payload.reasoning_effort as string | undefined },
	{ format: "together", readValue: (payload) => payload.reasoning_effort as string | undefined },
	{ format: "openrouter", readValue: getNestedEffort },
	{ format: "ant-ling", readValue: getNestedEffort },
	{ format: "string-thinking", readValue: (payload) => payload.thinking as string | undefined },
	{
		format: "chat-template",
		compat: { chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort" } } },
		readValue: (payload) => {
			const kwargs = payload.chat_template_kwargs;
			if (!kwargs || typeof kwargs !== "object") return undefined;
			const effort = (kwargs as Record<string, unknown>).reasoning_effort;
			return typeof effort === "string" ? effort : undefined;
		},
	},
];

async function captureCompletionsPayload(
	format: CompletionsThinkingFormat,
	thinkingLevelMap: ThinkingLevelMap | undefined,
	compat?: Pick<OpenAICompletionsCompat, "chatTemplateKwargs">,
): Promise<Record<string, unknown>> {
	const model = {
		...buildModel("openai-completions", thinkingLevelMap),
		compat: {
			thinkingFormat: format,
			supportsReasoningEffort: true,
			...compat,
		},
	} satisfies Model<"openai-completions">;
	return capturePayload((onPayload) =>
		streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoningEffort: "high",
			onPayload,
		}),
	);
}

describe.each(completionsFormats)("openai-completions $format thinking map", ({ format, compat, readValue }) => {
	it("passes through missing keys, maps strings, and omits null values", async () => {
		expect(readValue(await captureCompletionsPayload(format, undefined, compat))).toBe("high");
		expect(readValue(await captureCompletionsPayload(format, { high: "provider-high" }, compat))).toBe(
			"provider-high",
		);
		expect(readValue(await captureCompletionsPayload(format, { high: null }, compat))).toBeUndefined();
	});
});

type PayloadCapture = (thinkingLevelMap: ThinkingLevelMap | undefined) => Promise<Record<string, unknown>>;

const responseSerializers: Array<{
	name: string;
	capture: PayloadCapture;
	readValue: (payload: Record<string, unknown>) => string | undefined;
}> = [
	{
		name: "openai-responses",
		capture: (thinkingLevelMap) =>
			capturePayload((onPayload) =>
				streamOpenAIResponses(buildModel("openai-responses", thinkingLevelMap), context, {
					apiKey: "test-key",
					reasoningEffort: "high",
					onPayload,
				}),
			),
		readValue: getNestedEffort,
	},
	{
		name: "azure-openai-responses",
		capture: (thinkingLevelMap) =>
			capturePayload((onPayload) =>
				streamAzureOpenAIResponses(buildModel("azure-openai-responses", thinkingLevelMap), context, {
					apiKey: "test-key",
					reasoningEffort: "high",
					onPayload,
				}),
			),
		readValue: getNestedEffort,
	},
	{
		name: "openai-codex-responses",
		capture: (thinkingLevelMap) =>
			capturePayload((onPayload) =>
				streamOpenAICodexResponses(buildModel("openai-codex-responses", thinkingLevelMap), context, {
					apiKey: buildCodexToken(),
					transport: "sse",
					reasoningEffort: "high",
					onPayload,
				}),
			),
		readValue: getNestedEffort,
	},
	{
		name: "mistral-conversations",
		capture: (thinkingLevelMap) =>
			capturePayload((onPayload) =>
				streamMistralSimple(buildModel("mistral-conversations", thinkingLevelMap, "mistral-small-2603"), context, {
					apiKey: "test-key",
					reasoning: "high",
					onPayload,
				}),
			),
		readValue: (payload) => payload.reasoningEffort as string | undefined,
	},
];

function buildCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

describe.each(responseSerializers)("$name thinking map", ({ capture, readValue, name }) => {
	it("passes through missing keys, maps strings, and omits null values", async () => {
		expect(readValue(await capture(undefined))).toBe("high");
		expect(readValue(await capture({ high: "xhigh" }))).toBe("xhigh");
		const nullMap =
			name === "mistral-conversations" ? { minimal: null, low: null, medium: null, high: null } : { high: null };
		expect(readValue(await capture(nullMap))).toBeUndefined();
	});
});
