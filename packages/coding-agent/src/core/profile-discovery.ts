import type { RegistryApi } from "@handy_wote/pi-ai";
import { PROFILE_API_SERIALIZERS } from "./profile-api-resolution.ts";
import type { Profile } from "./profiles-types.ts";

export interface DiscoveredProfileModel {
	id: string;
	name: string;
	availableApis?: RegistryApi[];
	gatewayPreferredApi?: RegistryApi;
}

export interface ProfileDiscoveryResult {
	models: DiscoveredProfileModel[];
	availableApis: RegistryApi[];
	warnings: string[];
}

export interface ProfileDiscoveryOptions {
	fetch?: typeof fetch;
	probeApis?: boolean;
}

type CatalogAuthStyle = "openai" | "anthropic";

const API_ALIASES: Readonly<Record<string, RegistryApi>> = {
	"openai-completions": "openai-completions",
	"openai-chat-completions": "openai-completions",
	"chat-completions": "openai-completions",
	openai: "openai-completions",
	"openai-responses": "openai-responses",
	responses: "openai-responses",
	"anthropic-messages": "anthropic-messages",
	"anthropic-messages-api": "anthropic-messages",
	anthropic: "anthropic-messages",
	"mistral-conversations": "mistral-conversations",
	mistral: "mistral-conversations",
	"openai-codex-responses": "openai-codex-responses",
	"google-generative-ai": "google-generative-ai",
	"google-vertex": "google-vertex",
};

const PROBE_PATHS: Readonly<Partial<Record<RegistryApi, string>>> = {
	"openai-completions": "chat/completions",
	"openai-responses": "responses",
	"anthropic-messages": "messages",
	"mistral-conversations": "conversations",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApi(value: unknown): RegistryApi | undefined {
	return typeof value === "string" ? API_ALIASES[value.trim().toLowerCase()] : undefined;
}

function readApis(record: Record<string, unknown>): RegistryApi[] {
	const raw =
		record.apis ??
		record.supported_apis ??
		record.supportedApis ??
		record.available_apis ??
		record.availableApis ??
		record.protocols;
	const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	return Array.from(new Set(values.map(normalizeApi).filter((api): api is RegistryApi => api !== undefined)));
}

function readPreferredApi(record: Record<string, unknown>): RegistryApi | undefined {
	return normalizeApi(record.preferred_api ?? record.preferredApi ?? record.api ?? record.protocol);
}

function parseCatalog(value: unknown): { models: DiscoveredProfileModel[]; availableApis: RegistryApi[] } {
	if (!isRecord(value)) throw new Error("Model catalog must be a JSON object");
	const rawModels = value.data ?? value.models;
	if (!Array.isArray(rawModels)) throw new Error("Model catalog did not contain a model list");

	const models = rawModels.flatMap((raw): DiscoveredProfileModel[] => {
		if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) return [];
		const availableApis = readApis(raw);
		const gatewayPreferredApi = readPreferredApi(raw);
		const nameValue = raw.name ?? raw.display_name ?? raw.displayName;
		return [
			{
				id: raw.id,
				name: typeof nameValue === "string" && nameValue.length > 0 ? nameValue : raw.id,
				...(availableApis.length > 0 ? { availableApis } : {}),
				...(gatewayPreferredApi ? { gatewayPreferredApi } : {}),
			},
		];
	});

	return { models, availableApis: readApis(value) };
}

function authHeaders(profile: Profile, style: CatalogAuthStyle): Record<string, string> {
	if (style === "anthropic") {
		return {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"x-api-key": profile.apiKey,
		};
	}
	return { Authorization: `Bearer ${profile.apiKey}`, "Content-Type": "application/json" };
}

function catalogStyles(profile: Profile): CatalogAuthStyle[] {
	if (profile.protocol === "anthropic") return ["anthropic", "openai"];
	return ["openai", "anthropic"];
}

async function fetchCatalog(
	profile: Profile,
	fetchImpl: typeof fetch,
): Promise<{ models: DiscoveredProfileModel[]; availableApis: RegistryApi[] }> {
	const url = `${profile.baseUrl.replace(/\/+$/, "")}/models`;
	const failures: string[] = [];
	for (const style of catalogStyles(profile)) {
		try {
			const response = await fetchImpl(url, { headers: authHeaders(profile, style) });
			if (!response.ok) {
				failures.push(`${style}: ${response.status} ${response.statusText}`);
				continue;
			}
			return parseCatalog(await response.json());
		} catch (error) {
			failures.push(`${style}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Failed to fetch models from ${url}: ${failures.join("; ")}`);
}

async function probeAvailableApis(profile: Profile, fetchImpl: typeof fetch): Promise<RegistryApi[]> {
	const baseUrl = profile.baseUrl.replace(/\/+$/, "");
	const headers = {
		Authorization: `Bearer ${profile.apiKey}`,
		"anthropic-version": "2023-06-01",
		"x-api-key": profile.apiKey,
	};
	const results = await Promise.all(
		PROFILE_API_SERIALIZERS.map(async (api): Promise<RegistryApi | undefined> => {
			const path = PROBE_PATHS[api];
			if (!path) return undefined;
			try {
				const response = await fetchImpl(`${baseUrl}/${path}`, { method: "OPTIONS", headers });
				return response.ok ? api : undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return results.filter((api): api is RegistryApi => api !== undefined);
}

export async function discoverProfile(
	profile: Profile,
	options: ProfileDiscoveryOptions = {},
): Promise<ProfileDiscoveryResult> {
	const fetchImpl = options.fetch ?? fetch;
	const catalog = await fetchCatalog(profile, fetchImpl);
	const probedApis = options.probeApis === false ? [] : await probeAvailableApis(profile, fetchImpl);
	const availableApis = Array.from(new Set([...catalog.availableApis, ...probedApis]));
	const warnings: string[] = [];
	if (availableApis.length === 0) {
		warnings.push("The model catalog worked, but no generation API was confirmed; select an API manually.");
	}

	const models = catalog.models.map((model) => ({
		...model,
		availableApis: model.availableApis ?? availableApis,
	}));

	return { models, availableApis, warnings };
}
