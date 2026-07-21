import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type MetadataSource,
	type Profile,
	type UserModel,
} from "./profiles-types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevModel {
	name?: string;
	limit?: { context?: number; output?: number };
	reasoning?: boolean;
	attachment?: boolean;
	tool_call?: boolean;
}

interface ModelsDevProvider {
	name?: string;
	api?: string;
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
	return undefined;
}

function makeDefaultModel(id: string, name: string): UserModel {
	return {
		id,
		name,
		enabled: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsReasoning: false,
		supportsVision: false,
		supportsToolCall: true,
		metadataSource: "manual" as MetadataSource,
	};
}

function enrichOne(modelId: string, displayName: string, modelsDev: ModelsDevData): UserModel {
	const officialProvider = guessOfficialProvider(modelId);
	const matches: Array<{ model: ModelsDevModel; isOfficial: boolean }> = [];

	for (const [providerId, provider] of Object.entries(modelsDev)) {
		const model = provider.models?.[modelId];
		if (model) {
			matches.push({
				model,
				isOfficial: officialProvider === providerId,
			});
		}
	}

	if (matches.length === 0) {
		return makeDefaultModel(modelId, displayName);
	}

	matches.sort((a, b) => (b.isOfficial ? 1 : 0) - (a.isOfficial ? 1 : 0));
	const best = matches[0].model;

	const reasoning = matches.some((m) => m.model.reasoning === true);
	const vision = matches.some((m) => m.model.attachment === true);
	const toolCall = matches.some((m) => m.model.tool_call === true);

	const contexts = matches
		.map((m) => m.model.limit?.context)
		.filter((c): c is number => typeof c === "number" && c > 0)
		.sort((a, b) => a - b);
	const contextWindow = contexts.length > 0 ? contexts[Math.floor(contexts.length / 2)] : DEFAULT_CONTEXT_WINDOW;

	const outputs = matches
		.map((m) => m.model.limit?.output)
		.filter((o): o is number => typeof o === "number" && o > 0)
		.sort((a, b) => a - b);
	const maxTokens = outputs.length > 0 ? outputs[Math.floor(outputs.length / 2)] : DEFAULT_MAX_TOKENS;

	const name = best.name ?? displayName;
	const source: MetadataSource = matches.some((m) => m.isOfficial) ? "official" : "community";

	return {
		id: modelId,
		name,
		enabled: true,
		contextWindow,
		maxTokens,
		supportsReasoning: reasoning,
		supportsVision: vision,
		supportsToolCall: toolCall,
		metadataSource: source,
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

export async function enrichWithModelsDev(modelIds: Array<{ id: string; name: string }>): Promise<UserModel[]> {
	let catalog: ModelsDevData;
	try {
		catalog = await fetchModelsDevCatalog();
	} catch {
		return modelIds.map((m) => makeDefaultModel(m.id, m.name));
	}
	return modelIds.map((m) => enrichOne(m.id, m.name, catalog));
}

export function mergeProfileModels(
	existingModels: readonly UserModel[],
	enrichedModels: readonly UserModel[],
): UserModel[] {
	const existingById = new Map(existingModels.map((model) => [model.id, model]));
	return enrichedModels.map((model) => {
		const existing = existingById.get(model.id);
		if (!existing) return { ...model, enabled: false };
		if (existing.metadataSource === "manual") return { ...existing };
		return { ...model, enabled: existing.enabled };
	});
}

export async function fetchModelsFromEndpoint(profile: Profile): Promise<Array<{ id: string; name: string }>> {
	if (profile.protocol === "anthropic") {
		const url = `${profile.baseUrl.replace(/\/+$/, "")}/models`;
		const response = await fetch(url, {
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
				"x-api-key": profile.apiKey,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch models from ${url}: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
		const models = data.data ?? [];
		return models.map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
	}

	const url = `${profile.baseUrl.replace(/\/+$/, "")}/models`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${profile.apiKey}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch models from ${url}: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as { data?: Array<{ id: string }> };
	const models = data.data ?? [];
	return models.map((m) => ({ id: m.id, name: m.id }));
}
