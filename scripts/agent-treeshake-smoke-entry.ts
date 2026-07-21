import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicCompatProvider } from "@earendil-works/pi-ai/providers/anthropic-compat";

const models = createModels();
models.setProvider(
	anthropicCompatProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		apiKey: "smoke-test-key",
		models: [
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			},
		],
	}),
);
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFunction: models.streamSimple.bind(models),
});
