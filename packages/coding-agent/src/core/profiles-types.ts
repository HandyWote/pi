/** Profile types for user-defined gateway connections and model preferences. */

import type { ModelCost, RegistryApi, RegistryApiOverlays, RegistryDisplayGroup } from "@handy_wote/pi-ai";

export type ProfileProtocol = "openai" | "anthropic";

export type ProfileApiPreference = "auto" | RegistryApi;

export type MetadataSource = "official" | "community" | "default" | "manual";

export interface ProfileModelOverrides {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsReasoning?: boolean;
	supportsVision?: boolean;
	supportsToolCall?: boolean;
	cost?: Partial<ModelCost>;
	apis?: RegistryApiOverlays;
}

export interface UserModel {
	id: string;
	name: string;
	enabled: boolean;
	contextWindow: number;
	maxTokens: number;
	supportsReasoning: boolean;
	supportsVision: boolean;
	supportsToolCall: boolean;
	metadataSource: MetadataSource;
	cost?: ModelCost;
	group?: RegistryDisplayGroup;
	apiPreference?: ProfileApiPreference;
	availableApis?: RegistryApi[];
	gatewayPreferredApi?: RegistryApi;
	available?: boolean;
	lastSeenAt?: string;
	/** Explicit user values. Refresh replaces discovered fields, never these. */
	overrides?: ProfileModelOverrides;
}

export interface Profile {
	id: string;
	name: string;
	/** Catalog/fallback hint for existing profiles; it no longer forces every model API. */
	protocol?: ProfileProtocol;
	apiPreference?: ProfileApiPreference;
	availableApis?: RegistryApi[];
	familyApiPreferences?: Record<string, ProfileApiPreference>;
	discoveryWarnings?: string[];
	lastDiscoveredAt?: string;
	baseUrl: string;
	apiKey: string;
	models: UserModel[];
	createdAt: string;
	updatedAt: string;
}

export interface ProfilesFile {
	profiles: Profile[];
	activeProfileId?: string;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
