import type { ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type RegistryApi =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "mistral-conversations"
	| "google-generative-ai"
	| "google-vertex";

export interface RegistryDisplayGroup {
	id: string;
	label: string;
}

export interface RegistryApiOverlay {
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Partial<ThinkingLevelMap>;
}

export type RegistryApiOverlays = Partial<Record<RegistryApi, RegistryApiOverlay>>;

export type { ModelCost, ThinkingLevelMap };
