/** Profile declaration types: the user-facing gateway management language. */
import type {
	ModelCost,
	RegistryApi,
	RegistryApiOverlays,
	RegistryDisplayGroup,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";

export type ProfileProtocol = "openai" | "anthropic";

export type ProfileApiPreference = "auto" | RegistryApi;

export type MetadataSource = "official" | "community" | "default" | "manual";

/**
 * Reference to credentials held by the official auth store. The profile never
 * stores a plaintext API key.
 */
export interface ProfileAuthReference {
	/** Provider ID under the official auth store (auth.json). */
	authProviderId: string;
	/** Optional human-readable label shown in the UI. */
	label?: string;
}

export interface ProfileModelOverrides {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsReasoning?: boolean;
	supportsVision?: boolean;
	cost?: Partial<ModelCost>;
	thinkingLevelMap?: Partial<ThinkingLevelMap>;
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
	metadataSource: MetadataSource;
	/** Maps pi thinking levels to provider/model-specific values (from models.dev effort options). */
	thinkingLevelMap?: Partial<ThinkingLevelMap>;
	cost?: ModelCost;
	group?: RegistryDisplayGroup;
	apiPreference?: ProfileApiPreference;
	availableApis?: RegistryApi[];
	gatewayPreferredApi?: RegistryApi;
	available?: boolean;
	lastSeenAt?: string;
	/** User-confirmed canonical identity in the official catalog. */
	canonicalId?: string;
	/** Explicit user values. Refresh replaces discovered fields, never these. */
	overrides?: ProfileModelOverrides;
}

export interface ProfileApiRoute {
	/** Base URL passed to this API's serializer or SDK. */
	sdkBaseUrl: string;
	/** Whether this route was confirmed by automatic or manual verification. */
	verified?: boolean;
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
	/** Extra static headers sent with every request to this gateway. */
	headers?: Record<string, string>;
	/** Confirmed automatic or manually configured SDK base URLs, keyed by API. */
	apiRoutes?: Partial<Record<RegistryApi, ProfileApiRoute>>;
	/** Reference to credentials in the official auth store; never a plaintext key. */
	authReference: ProfileAuthReference;
	models: UserModel[];
	createdAt: string;
	updatedAt: string;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
