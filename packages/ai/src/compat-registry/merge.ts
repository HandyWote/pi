import type {
	CompiledModelCompatRegistry,
	RegistryApi,
	RegistryApiCompatMap,
	RegistryApiOverlay,
	RegistryApiOverlays,
	RegistryModelCost,
	RegistryModelMetadata,
	RegistryModelOverlay,
	ResolvedCompatOverlay,
} from "./types.ts";

function mergeCost(base: RegistryModelCost | undefined, override: RegistryModelCost | undefined) {
	if (!base) return override;
	if (!override) return base;
	return { ...base, ...override };
}

function mergeMetadata(
	base: RegistryModelMetadata | undefined,
	override: RegistryModelMetadata | undefined,
): RegistryModelMetadata | undefined {
	if (!base) return override;
	if (!override) return base;
	const cost = mergeCost(base.cost, override.cost);
	const merged: RegistryModelMetadata = {
		...base,
		...override,
	};
	if (cost) merged.cost = cost;
	return merged;
}

function mergeApiOverlay<TCompat>(
	base: RegistryApiOverlay<TCompat> | undefined,
	override: RegistryApiOverlay<TCompat> | undefined,
): RegistryApiOverlay<TCompat> | undefined {
	if (!base) return override;
	if (!override) return base;
	const merged: RegistryApiOverlay<TCompat> = {};
	if (base.compat || override.compat) {
		merged.compat = { ...base.compat, ...override.compat } as RegistryApiOverlay<TCompat>["compat"];
	}
	if (base.thinkingLevelMap || override.thinkingLevelMap) {
		merged.thinkingLevelMap = { ...base.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	return merged;
}

function mergeApis(base: RegistryApiOverlays | undefined, override: RegistryApiOverlays | undefined) {
	if (!base) return override;
	if (!override) return base;
	return {
		"openai-completions": mergeApiOverlay(base["openai-completions"], override["openai-completions"]),
		"openai-responses": mergeApiOverlay(base["openai-responses"], override["openai-responses"]),
		"openai-codex-responses": mergeApiOverlay(base["openai-codex-responses"], override["openai-codex-responses"]),
		"anthropic-messages": mergeApiOverlay(base["anthropic-messages"], override["anthropic-messages"]),
		"mistral-conversations": mergeApiOverlay(base["mistral-conversations"], override["mistral-conversations"]),
		"google-generative-ai": mergeApiOverlay(base["google-generative-ai"], override["google-generative-ai"]),
		"google-vertex": mergeApiOverlay(base["google-vertex"], override["google-vertex"]),
	};
}

export function mergeModelCompatOverlays(
	base: RegistryModelOverlay | undefined,
	override: RegistryModelOverlay | undefined,
): RegistryModelOverlay | undefined {
	if (!base) return override;
	if (!override) return base;
	return {
		metadata: mergeMetadata(base.metadata, override.metadata),
		group: override.group ?? base.group,
		preferredApis: override.preferredApis ?? base.preferredApis,
		apis: mergeApis(base.apis, override.apis),
	};
}

function matchesFamily(source: CompiledModelCompatRegistry, modelId: string): RegistryModelOverlay | undefined {
	for (const family of source.families) {
		if (family.matcher.ids.has(modelId) || family.matcher.prefixes.some((prefix) => modelId.startsWith(prefix))) {
			return family.entry;
		}
	}
	return undefined;
}

/**
 * Resolves family and exact model overlays while preserving registry source
 * priority. Within each source, the first family matches and the exact model
 * wins per field. Later sources then override earlier sources per field.
 */
export function lookupModelCompatOverlay(
	sources: readonly CompiledModelCompatRegistry[],
	modelId: string,
): RegistryModelOverlay | undefined {
	const normalizedModelId = modelId.toLowerCase();
	let resolved: RegistryModelOverlay | undefined;
	for (const source of sources) {
		const sourceOverlay = mergeModelCompatOverlays(
			matchesFamily(source, normalizedModelId),
			source.models.get(normalizedModelId),
		);
		resolved = mergeModelCompatOverlays(resolved, sourceOverlay);
	}
	return resolved;
}

export function lookupCompatOverlay<TApi extends RegistryApi>(
	sources: readonly CompiledModelCompatRegistry[],
	modelId: string,
	api: TApi,
): ResolvedCompatOverlay<TApi> | undefined {
	const modelOverlay = lookupModelCompatOverlay(sources, modelId);
	if (!modelOverlay) return undefined;
	const apiOverlay = modelOverlay.apis?.[api] as RegistryApiOverlay<RegistryApiCompatMap[TApi]> | undefined;
	return {
		metadata: modelOverlay.metadata,
		group: modelOverlay.group,
		preferredApis: modelOverlay.preferredApis,
		compat: apiOverlay?.compat,
		thinkingLevelMap: apiOverlay?.thinkingLevelMap,
	};
}
