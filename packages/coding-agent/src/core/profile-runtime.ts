import { type Api, createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Profile, UserModel } from "./profiles-types.ts";

function userModelToModel(userModel: UserModel, profile: Profile): Model<Api> {
	const api: Api = profile.protocol === "anthropic" ? "anthropic-messages" : "openai-completions";

	return {
		id: userModel.id,
		name: userModel.name,
		provider: profile.id,
		api,
		baseUrl: profile.baseUrl,
		reasoning: userModel.supportsReasoning,
		input: userModel.supportsVision ? (["text", "image"] as const) : (["text"] as const),
		contextWindow: userModel.contextWindow,
		maxTokens: userModel.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

export function createProfileProvider(profile: Profile): Provider {
	const enabledModels = profile.models.filter((m) => m.enabled);
	const models = enabledModels.map((m) => userModelToModel(m, profile));

	if (profile.protocol === "anthropic") {
		return createProvider<"anthropic-messages">({
			id: profile.id,
			name: profile.name,
			baseUrl: profile.baseUrl,
			auth: {
				apiKey: {
					name: "API Key",
					resolve: async () => ({ auth: { apiKey: profile.apiKey } }),
				},
			},
			models: models as Model<"anthropic-messages">[],
			api: anthropicMessagesApi(),
		});
	}

	return createProvider<"openai-completions">({
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		auth: {
			apiKey: {
				name: "API Key",
				resolve: async () => ({ auth: { apiKey: profile.apiKey } }),
			},
		},
		models: models as Model<"openai-completions">[],
		api: {
			"openai-completions": openAICompletionsApi(),
		},
	});
}
