import type {
	AnthropicMessagesCompat,
	ModelCost,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	ThinkingLevelMap,
} from "../types.ts";

export type RegistryApi =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "mistral-conversations"
	| "google-generative-ai"
	| "google-vertex";

export interface RegistryApiCompatMap {
	"openai-completions": OpenAICompletionsCompat;
	"openai-responses": OpenAIResponsesCompat;
	"openai-codex-responses": OpenAIResponsesCompat;
	"anthropic-messages": AnthropicMessagesCompat;
	"mistral-conversations": never;
	"google-generative-ai": never;
	"google-vertex": never;
}

export interface RegistryApiOverlay<TCompat> {
	compat?: [TCompat] extends [never] ? never : Partial<TCompat>;
	thinkingLevelMap?: Partial<ThinkingLevelMap>;
}

export type RegistryApiOverlays = {
	[TApi in RegistryApi]?: RegistryApiOverlay<RegistryApiCompatMap[TApi]>;
};

export interface RegistryModelCost extends Partial<ModelCost> {}

export interface RegistryModelMetadata {
	name?: string;
	reasoning?: boolean;
	vision?: boolean;
	toolCall?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: RegistryModelCost;
}

export interface RegistryDisplayGroup {
	id: string;
	label: string;
}

export interface RegistryMatcher {
	ids?: string[];
	prefixes?: string[];
}

export interface RegistryModelOverlay {
	metadata?: RegistryModelMetadata;
	group?: RegistryDisplayGroup;
	preferredApis?: RegistryApi[];
	apis?: RegistryApiOverlays;
}

export interface ModelCompatFamily extends RegistryModelOverlay {
	id: string;
	match: RegistryMatcher;
}

export interface ModelCompatModel extends RegistryModelOverlay {
	id: string;
	aliases?: string[];
}

export interface ModelCompatRegistry {
	version: 1;
	families: ModelCompatFamily[];
	models?: ModelCompatModel[];
}

export interface CompiledRegistryMatcher {
	ids: ReadonlySet<string>;
	prefixes: readonly string[];
}

export interface CompiledModelCompatFamily {
	entry: ModelCompatFamily;
	matcher: CompiledRegistryMatcher;
}

export interface CompiledModelCompatRegistry {
	version: 1;
	families: readonly CompiledModelCompatFamily[];
	models: ReadonlyMap<string, ModelCompatModel>;
}

export interface ResolvedCompatOverlay<TApi extends RegistryApi = RegistryApi> {
	metadata?: RegistryModelMetadata;
	group?: RegistryDisplayGroup;
	preferredApis?: RegistryApi[];
	compat?: Partial<RegistryApiCompatMap[TApi]>;
	thinkingLevelMap?: Partial<ThinkingLevelMap>;
}
