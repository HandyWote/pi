import {
	type Api,
	BUILTIN_COMPAT_REGISTRY,
	type CompiledModelCompatRegistry,
	createProvider,
	lookupCompatOverlay,
	type Model,
	type ModelCost,
	type Provider,
	type RegistryApi,
} from "@handy_wote/pi-ai";
import { anthropicMessagesApi } from "@handy_wote/pi-ai/api/anthropic-messages.lazy";
import { mistralConversationsApi } from "@handy_wote/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@handy_wote/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@handy_wote/pi-ai/api/openai-responses.lazy";
import { resolveProfileModelApi } from "./profile-api-resolution.ts";
import type { Profile, UserModel } from "./profiles-types.ts";

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function profileModelToModel(
	userModel: UserModel,
	profile: Profile,
	registrySources: readonly CompiledModelCompatRegistry[],
): Model<Api> {
	const resolution = resolveProfileModelApi(profile, userModel, { registrySources });
	if (!resolution.api) {
		throw new Error(`Profile ${profile.name}, model ${userModel.id}: ${resolution.reason ?? "API is unresolved"}`);
	}

	const api = resolution.api;
	const overlay = lookupCompatOverlay(registrySources, userModel.id, api);
	const metadata = overlay?.metadata;
	const manual = userModel.overrides;
	const manualApi = manual?.apis?.[api];
	const baseCompat = api === "openai-completions" ? { supportsDeveloperRole: false } : undefined;
	const compat = { ...baseCompat, ...overlay?.compat, ...manualApi?.compat };
	const thinkingLevelMap = {
		...userModel.thinkingLevelMap,
		...overlay?.thinkingLevelMap,
		...manualApi?.thinkingLevelMap,
	};
	const cost: ModelCost = { ...ZERO_COST, ...userModel.cost, ...metadata?.cost, ...manual?.cost };

	return {
		id: userModel.id,
		name: manual?.name ?? metadata?.name ?? userModel.name,
		provider: profile.id,
		api,
		reasoning: manual?.supportsReasoning ?? metadata?.reasoning ?? userModel.supportsReasoning,
		input:
			(manual?.supportsVision ?? metadata?.vision ?? userModel.supportsVision)
				? (["text", "image"] as const)
				: (["text"] as const),
		contextWindow: manual?.contextWindow ?? metadata?.contextWindow ?? userModel.contextWindow,
		maxTokens: manual?.maxTokens ?? metadata?.maxTokens ?? userModel.maxTokens,
		cost,
		baseUrl: profile.apiRoutes?.[api]?.sdkBaseUrl ?? profile.baseUrl,
		...(Object.keys(compat).length > 0 ? { compat } : {}),
		...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
	} as Model<Api>;
}

export function createProfileProvider(
	profile: Profile,
	registrySources: readonly CompiledModelCompatRegistry[] = [BUILTIN_COMPAT_REGISTRY],
): Provider {
	const result = buildProfileProvider(profile, registrySources);
	if (result.diagnostics.length > 0) throw new Error(result.diagnostics.join("; "));
	return result.provider;
}

export interface ProfileProviderBuildResult {
	provider: Provider;
	diagnostics: string[];
}

export function buildProfileProvider(
	profile: Profile,
	registrySources: readonly CompiledModelCompatRegistry[] = [BUILTIN_COMPAT_REGISTRY],
): ProfileProviderBuildResult {
	const models: Model<Api>[] = [];
	const diagnostics: string[] = [];
	for (const model of profile.models) {
		if (!model.enabled || model.available === false) continue;
		try {
			models.push(profileModelToModel(model, profile, registrySources));
		} catch (error) {
			diagnostics.push(error instanceof Error ? error.message : String(error));
		}
	}
	const usedApis = new Set(models.map((model) => model.api as RegistryApi));
	const api = {
		...(usedApis.has("openai-completions") ? { "openai-completions": openAICompletionsApi() } : {}),
		...(usedApis.has("openai-responses") ? { "openai-responses": openAIResponsesApi() } : {}),
		...(usedApis.has("anthropic-messages") ? { "anthropic-messages": anthropicMessagesApi() } : {}),
		...(usedApis.has("mistral-conversations") ? { "mistral-conversations": mistralConversationsApi() } : {}),
	};

	return {
		provider: createProvider({
			id: profile.id,
			name: profile.name,
			baseUrl: profile.baseUrl,
			auth: {
				apiKey: {
					name: "API Key",
					resolve: async () => ({ auth: { apiKey: profile.apiKey } }),
				},
			},
			models,
			api,
		}),
		diagnostics,
	};
}
