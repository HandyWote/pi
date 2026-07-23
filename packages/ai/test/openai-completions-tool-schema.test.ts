import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Model, OpenAICompletionsCompat, StreamOptions, Tool } from "../src/types.ts";

interface ToolPayload {
	tools?: Array<{
		function: {
			parameters: Record<string, unknown>;
		};
	}>;
}

function buildModel(compat?: OpenAICompletionsCompat): Model<"openai-completions"> {
	return {
		id: "deepseek-test",
		name: "DeepSeek Test",
		api: "openai-completions",
		provider: "custom-gateway",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...(compat ? { compat } : {}),
	};
}

async function capturePayload(tools: Tool[], compat?: OpenAICompletionsCompat): Promise<ToolPayload> {
	let captured: unknown;
	const onPayload: NonNullable<StreamOptions["onPayload"]> = (payload) => {
		captured = payload;
	};
	const events = streamOpenAICompletions(
		buildModel(compat),
		{ messages: [{ role: "user", content: "diagnose", timestamp: 1 }], tools },
		{ apiKey: "test-key", signal: AbortSignal.abort(), onPayload },
	);
	for await (const _event of events as AsyncIterable<AssistantMessageEvent>) {
		// Drain the terminal error produced by the intentionally aborted request.
	}
	if (!captured || typeof captured !== "object") {
		throw new Error("OpenAI Completions payload was not captured");
	}
	return captured as ToolPayload;
}

function getFirstParameters(payload: ToolPayload): Record<string, unknown> {
	const parameters = payload.tools?.[0]?.function.parameters;
	if (!parameters) throw new Error("Expected one serialized tool");
	return parameters;
}

describe("openai-completions tool schema compat", () => {
	it("leaves an optional-only schema unchanged when compat is disabled", async () => {
		const parameters = Type.Object({
			filePath: Type.Optional(Type.String()),
			severity: Type.Optional(Type.String()),
		});

		const payload = await capturePayload([{ name: "lens_diagnostics", description: "Get diagnostics", parameters }]);

		expect(getFirstParameters(payload)).not.toHaveProperty("required");
		expect(parameters).not.toHaveProperty("required");
	});

	it("shallow-clones an optional-only object schema and adds required: [] when enabled", async () => {
		const nestedOptions = Type.Object({ line: Type.Optional(Type.Number()) });
		const parameters = Type.Object({
			filePath: Type.Optional(Type.String()),
			options: Type.Optional(nestedOptions),
		});

		const payload = await capturePayload([{ name: "lsp_diagnostics", description: "Get diagnostics", parameters }], {
			requiresToolSchemaRequiredArray: true,
		});
		const serialized = getFirstParameters(payload);
		const serializedProperties = serialized.properties as Record<string, Record<string, unknown>>;

		expect(serialized).not.toBe(parameters);
		expect(serialized.required).toEqual([]);
		expect(serializedProperties.options).not.toHaveProperty("required");
		expect(parameters).not.toHaveProperty("required");
		expect(nestedOptions).not.toHaveProperty("required");
	});

	it("preserves an existing required array", async () => {
		const parameters = Type.Object({
			filePath: Type.String(),
			severity: Type.Optional(Type.String()),
		});

		const payload = await capturePayload([{ name: "lens_diagnostics", description: "Get diagnostics", parameters }], {
			requiresToolSchemaRequiredArray: true,
		});

		expect(getFirstParameters(payload).required).toEqual(["filePath"]);
		expect(parameters.required).toEqual(["filePath"]);
	});
});
