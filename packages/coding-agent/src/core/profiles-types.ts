/** Profile types for user-defined connection configurations. */

export type ProfileProtocol = "openai" | "anthropic";

export type MetadataSource = "official" | "community" | "manual";

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
}

export interface Profile {
	id: string;
	name: string;
	protocol: ProfileProtocol;
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
