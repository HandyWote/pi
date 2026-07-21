import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicCompatProvider } from "@earendil-works/pi-ai/providers/anthropic-compat";
import { openAICompatProvider } from "@earendil-works/pi-ai/providers/openai-compat";
import type { Profile, UserModel } from "./profiles-types.ts";

function userModelToModel(userModel: UserModel, profile: Profile): Model<Api> {
	const api: Api = profile.protocol === "anthropic" ? "anthropic-messages" : "openai-responses";

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
		return anthropicCompatProvider({
			id: profile.id,
			name: profile.name,
			baseUrl: profile.baseUrl,
			apiKey: profile.apiKey,
			models: models as Model<"anthropic-messages">[],
		});
	}

	return openAICompatProvider({
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		models: models as Model<"openai-responses" | "openai-completions">[],
	});
}
