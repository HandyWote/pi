import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import type { Provider } from "../models.ts";
import { createProvider } from "../models.ts";
import type { Model } from "../types.ts";

export function openAICompatProvider(config: {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: Model<"openai-responses" | "openai-completions">[];
}): Provider<"openai-responses" | "openai-completions"> {
	return createProvider<"openai-responses" | "openai-completions">({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: "API Key",
				resolve: async () => ({
					auth: { apiKey: config.apiKey },
				}),
			},
		},
		models: config.models,
		api: {
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
