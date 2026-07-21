import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import type { Provider } from "../models.ts";
import { createProvider } from "../models.ts";
import type { Model } from "../types.ts";

export function anthropicCompatProvider(config: {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: Model<"anthropic-messages">[];
}): Provider<"anthropic-messages"> {
	return createProvider<"anthropic-messages">({
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
		api: anthropicMessagesApi(),
	});
}
