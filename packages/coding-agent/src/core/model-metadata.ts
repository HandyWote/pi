import {
	BUILTIN_COMPAT_REGISTRY,
	type CompiledModelCompatRegistry,
	lookupModelCompatOverlay,
	type ModelCost,
	type RegistryDisplayGroup,
} from "@handy_wote/pi-ai";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";
import type { DiscoveredProfileModel } from "./profile-discovery.ts";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type ProfileModelOverrides,
	type UserModel,
} from "./profiles-types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevCostTier {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	tier?: { type?: string; size?: number };
}

interface ModelsDevModel {
	name?: string;
	limit?: { context?: number; output?: number };
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	attachment?: boolean;
	tool_call?: boolean;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: ModelsDevCostTier[];
	};
}

interface ModelsDevProvider {
	models: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

function guessOfficialProvider(modelId: string): string | undefined {
	const lower = modelId.toLowerCase();
	if (lower.includes("gpt-") || lower.includes("codex") || lower.includes("gpt-image")) return "openai";
	if (lower.includes("claude")) return "anthropic";
	if (lower.includes("deepseek")) return "deepseek";
	if (lower.includes("qwen")) return "alibaba";
	if (lower.includes("glm")) return "zhipuai";
	if (lower.includes("gemini") || lower.includes("gemma")) return "google";
	if (lower.includes("grok")) return "xai";
	if (lower.includes("mistral") || lower.includes("codestral")) return "mistral";
	return undefined;
}

function zeroCost(): ModelCost {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function modelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const tiers = cost?.tiers?.flatMap((tier) => {
		if (tier.tier?.type !== "context" || tier.tier.size === undefined) return [];
		return [
			{
				inputTokensAbove: tier.tier.size,
				input: tier.input ?? 0,
				output: tier.output ?? 0,
				cacheRead: tier.cache_read ?? 0,
				cacheWrite: tier.cache_write ?? 0,
			},
		];
	});
	return {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
		cacheRead: cost?.cache_read ?? 0,
		cacheWrite: cost?.cache_write ?? 0,
		...(tiers?.length ? { tiers } : {}),
	};
}

export function inferModelDisplayGroup(modelId: string, name = modelId): RegistryDisplayGroup {
	const value = `${modelId} ${name}`.toLowerCase();
	if (value.includes("claude")) return { id: "claude", label: "Claude" };
	if (value.includes("deepseek")) return { id: "deepseek", label: "DeepSeek" };
	if (value.includes("qwen")) return { id: "qwen", label: "Qwen" };
	if (value.includes("kimi") || value.includes("moonshot")) return { id: "kimi", label: "Kimi" };
	if (value.includes("glm")) return { id: "glm", label: "GLM" };
	if (value.includes("gemini") || value.includes("gemma")) return { id: "google", label: "Google" };
	if (value.includes("grok")) return { id: "grok", label: "Grok" };
	if (value.includes("mistral") || value.includes("codestral")) return { id: "mistral", label: "Mistral" };
	if (value.includes("gpt") || value.includes("codex") || /(^|[\s/_-])o\d/.test(value)) {
		return { id: "gpt", label: "GPT" };
	}
	return { id: "other", label: "Other models" };
}

function makeDefaultModel(
	discovered: DiscoveredProfileModel,
	registrySources: readonly CompiledModelCompatRegistry[],
): UserModel {
	const registryGroup = lookupModelCompatOverlay(registrySources, discovered.id)?.group;
	return {
		...discovered,
		name: discovered.name,
		enabled: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsReasoning: false,
		supportsVision: false,
		supportsToolCall: true,
		metadataSource: "default",
		cost: zeroCost(),
		group: registryGroup ?? inferModelDisplayGroup(discovered.id, discovered.name),
		available: true,
	};
}

function enrichOne(
	discovered: DiscoveredProfileModel,
	modelsDev: ModelsDevData,
	registrySources: readonly CompiledModelCompatRegistry[],
): UserModel {
	const officialProvider = guessOfficialProvider(discovered.id);
	const matches: Array<{ model: ModelsDevModel; isOfficial: boolean }> = [];

	for (const [providerId, provider] of Object.entries(modelsDev)) {
		const model = provider.models?.[discovered.id];
		if (model) matches.push({ model, isOfficial: officialProvider === providerId });
	}

	if (matches.length === 0) return makeDefaultModel(discovered, registrySources);

	matches.sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial));
	const best = matches[0].model;
	const contexts = matches
		.map((match) => match.model.limit?.context)
		.filter((value): value is number => typeof value === "number" && value > 0)
		.sort((a, b) => a - b);
	const outputs = matches
		.map((match) => match.model.limit?.output)
		.filter((value): value is number => typeof value === "number" && value > 0)
		.sort((a, b) => a - b);
	const registryGroup = lookupModelCompatOverlay(registrySources, discovered.id)?.group;
	const thinkingLevelMap =
		discovered.thinkingLevelMap ??
		(best.reasoning_options ? getEffortThinkingLevelMap(best.reasoning_options) : undefined);

	return {
		...discovered,
		name: best.name ?? discovered.name,
		enabled: true,
		contextWindow: contexts.length ? contexts[Math.floor(contexts.length / 2)] : DEFAULT_CONTEXT_WINDOW,
		maxTokens: outputs.length ? outputs[Math.floor(outputs.length / 2)] : DEFAULT_MAX_TOKENS,
		supportsReasoning: matches.some((match) => match.model.reasoning === true),
		supportsVision: matches.some((match) => match.model.attachment === true),
		supportsToolCall: matches.some((match) => match.model.tool_call === true),
		metadataSource: matches.some((match) => match.isOfficial) ? "official" : "community",
		cost: modelsDevCost(best.cost),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		group: registryGroup ?? inferModelDisplayGroup(discovered.id, best.name ?? discovered.name),
		available: true,
	};
}

let cachedModelsDev: ModelsDevData | undefined;

export async function fetchModelsDevCatalog(): Promise<ModelsDevData> {
	if (cachedModelsDev) return cachedModelsDev;
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
	cachedModelsDev = (await response.json()) as ModelsDevData;
	return cachedModelsDev;
}

export function clearModelsDevCache(): void {
	cachedModelsDev = undefined;
}

export async function enrichWithModelsDev(
	models: DiscoveredProfileModel[],
	registrySources: readonly CompiledModelCompatRegistry[] = [BUILTIN_COMPAT_REGISTRY],
): Promise<UserModel[]> {
	let catalog: ModelsDevData;
	try {
		catalog = await fetchModelsDevCatalog();
	} catch {
		return models.map((model) => makeDefaultModel(model, registrySources));
	}
	return models.map((model) => enrichOne(model, catalog, registrySources));
}

function legacyManualOverrides(model: UserModel): ProfileModelOverrides | undefined {
	if (model.overrides) return model.overrides;
	if (model.metadataSource !== "manual") return undefined;
	return {
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportsReasoning: model.supportsReasoning,
		supportsVision: model.supportsVision,
		supportsToolCall: model.supportsToolCall,
		...(model.cost ? { cost: model.cost } : {}),
	};
}

export function mergeProfileModels(
	existingModels: readonly UserModel[],
	enrichedModels: readonly UserModel[],
	seenAt = new Date().toISOString(),
): UserModel[] {
	const existingById = new Map(existingModels.map((model) => [model.id, model]));
	const current = enrichedModels.map((model) => {
		const existing = existingById.get(model.id);
		if (!existing) return { ...model, enabled: false, available: true, lastSeenAt: seenAt };
		existingById.delete(model.id);
		const overrides = legacyManualOverrides(existing);
		return {
			...model,
			enabled: existing.enabled,
			available: true,
			lastSeenAt: seenAt,
			...(existing.apiPreference ? { apiPreference: existing.apiPreference } : {}),
			...(overrides ? { overrides } : {}),
		};
	});
	const unavailable = Array.from(existingById.values(), (model) => ({ ...model, available: false }));
	return [...current, ...unavailable];
}
