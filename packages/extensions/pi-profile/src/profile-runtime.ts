import {
	type Api,
	createProvider,
	type Model,
	type ModelCost,
	type Provider,
	type RegistryApi,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { lazyApi } from "@earendil-works/pi-ai/api/lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { readApiKey } from "./auth-json.ts";
import { resolveProfileModelApi } from "./profile-api-resolution.ts";
import type { Profile, UserModel } from "./profiles-types.ts";

/**
 * Transitional credential resolution matching profile-discovery's
 * resolveAuthApiKey. TODO(upstream-migration): replace with the official
 * auth.json lookup via the auth reference.
 */
function resolveAuthApiKey(profile: Profile): string {
	return readApiKey(profile.authReference.authProviderId) ?? "";
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function profileModelToModel(userModel: UserModel, profile: Profile): Model<Api> {
	const resolution = resolveProfileModelApi(profile, userModel);
	if (!resolution.api) {
		throw new Error(`Profile ${profile.name}, model ${userModel.id}: ${resolution.reason ?? "API is unresolved"}`);
	}

	const api = resolution.api;
	const manual = userModel.overrides;
	const manualApi = manual?.apis?.[api];
	const baseCompat = api === "openai-completions" ? { supportsDeveloperRole: false } : undefined;
	const compat = { ...baseCompat, ...manualApi?.compat };
	const thinkingLevelMap = {
		...userModel.thinkingLevelMap,
		...manualApi?.thinkingLevelMap,
	};
	const cost: ModelCost = { ...ZERO_COST, ...userModel.cost, ...manual?.cost };

	return {
		id: userModel.id,
		name: manual?.name ?? userModel.name,
		provider: profile.id,
		api,
		reasoning: manual?.supportsReasoning ?? userModel.supportsReasoning,
		input: (manual?.supportsVision ?? userModel.supportsVision) ? (["text", "image"] as const) : (["text"] as const),
		contextWindow: manual?.contextWindow ?? userModel.contextWindow,
		maxTokens: manual?.maxTokens ?? userModel.maxTokens,
		cost,
		baseUrl: profile.apiRoutes?.[api]?.sdkBaseUrl ?? profile.baseUrl,
		...(Object.keys(compat).length > 0 ? { compat } : {}),
		...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
	} as Model<Api>;
}

export function createProfileProvider(profile: Profile): Provider {
	const result = buildProfileProvider(profile);
	if (result.diagnostics.length > 0) throw new Error(result.diagnostics.join("; "));
	return result.provider;
}

export interface ProfileProviderBuildResult {
	provider: Provider;
	diagnostics: string[];
}

export function buildProfileProvider(profile: Profile): ProfileProviderBuildResult {
	const models: Model<Api>[] = [];
	const diagnostics: string[] = [];
	for (const model of profile.models) {
		if (!model.enabled || model.available === false) continue;
		try {
			models.push(profileModelToModel(model, profile));
		} catch (error) {
			diagnostics.push(error instanceof Error ? error.message : String(error));
		}
	}
	const usedApis = new Set(models.map((model) => model.api as RegistryApi));
	// lazyApi defers module loading until first stream; each call site keeps
	// its own ProviderStreams identity, so the map satisfies the official
	// ProviderStreams type without cross-copy private-field mismatches.
	const api = {
		...(usedApis.has("openai-completions")
			? { "openai-completions": lazyApi(async () => openAICompletionsApi()) }
			: {}),
		...(usedApis.has("openai-responses") ? { "openai-responses": lazyApi(async () => openAIResponsesApi()) } : {}),
		...(usedApis.has("anthropic-messages")
			? { "anthropic-messages": lazyApi(async () => anthropicMessagesApi()) }
			: {}),
		...(usedApis.has("mistral-conversations")
			? { "mistral-conversations": lazyApi(async () => mistralConversationsApi()) }
			: {}),
	};

	return {
		provider: createProvider({
			id: profile.id,
			name: profile.name,
			baseUrl: profile.baseUrl,
			auth: {
				apiKey: {
					name: "API Key",
					resolve: async () => ({ auth: { apiKey: resolveAuthApiKey(profile) } }),
				},
			},
			models,
			api,
		}),
		diagnostics,
	};
}
