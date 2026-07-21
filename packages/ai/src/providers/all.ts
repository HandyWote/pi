import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { MODELS } from "../models.generated.ts";
import type { CreateModelsOptions } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { openrouterImagesProvider } from "./openrouter-images.ts";
import { radiusProvider } from "./radius.ts";

export { anthropicCompatProvider } from "./anthropic-compat.ts";
export { openAICompatProvider } from "./openai-compat.ts";

export { radiusProvider };

/** @deprecated Stub — use profiles instead. Returns empty array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function builtinProviders(): any[] {
	return [];
}

/** @deprecated Stub — use profiles instead. Returns empty record. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function builtinModels(): any {
	return {};
}

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
export type BuiltinProvider = keyof typeof MODELS;

type BuiltinModelApi<
	TProvider extends BuiltinProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

/** Typed read of the generated built-in catalog. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<BuiltinModelApi<TProvider, TModelId>> {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models?.[modelId as string] as Model<BuiltinModelApi<TProvider, TModelId>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models
		? (Object.values(models) as Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[])
		: [];
}

/** All built-in image-generation providers, freshly constructed. */
export function builtinImagesProviders(): ImagesProvider[] {
	return [openrouterImagesProvider()];
}

/** An `ImagesModels` collection with every built-in image-generation provider registered. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
