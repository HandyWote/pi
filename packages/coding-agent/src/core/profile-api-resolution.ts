import {
	BUILTIN_COMPAT_REGISTRY,
	type CompiledModelCompatRegistry,
	lookupModelCompatOverlay,
	type RegistryApi,
} from "@handy_wote/pi-ai";
import type { Profile, ProfileApiPreference, UserModel } from "./profiles-types.ts";

export const PROFILE_API_SERIALIZERS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"mistral-conversations",
] as const satisfies readonly RegistryApi[];

export type ProfileApiResolutionSource =
	| "model"
	| "family"
	| "gateway"
	| "registry"
	| "profile"
	| "legacy"
	| "available"
	| "unresolved";

export interface ProfileApiResolution {
	api?: RegistryApi;
	source: ProfileApiResolutionSource;
	availableApis: RegistryApi[];
	reason?: string;
}

export interface ResolveProfileApiOptions {
	registrySources?: readonly CompiledModelCompatRegistry[];
	installedApis?: readonly RegistryApi[];
}

function explicitPreference(preference: ProfileApiPreference | undefined): RegistryApi | undefined {
	return preference && preference !== "auto" ? preference : undefined;
}

function legacyApi(profile: Profile): RegistryApi | undefined {
	if (profile.protocol === "anthropic") return "anthropic-messages";
	if (profile.protocol === "openai") return "openai-completions";
	return undefined;
}

function resolveExplicit(
	api: RegistryApi,
	source: Exclude<ProfileApiResolutionSource, "unresolved">,
	installed: ReadonlySet<RegistryApi>,
	availableApis: RegistryApi[],
): ProfileApiResolution {
	if (installed.has(api)) return { api, source, availableApis };
	return {
		source: "unresolved",
		availableApis,
		reason: `${api} was selected by ${source}, but its serializer is not installed`,
	};
}

export function resolveProfileModelApi(
	profile: Profile,
	model: UserModel,
	options: ResolveProfileApiOptions = {},
): ProfileApiResolution {
	const installed = new Set(options.installedApis ?? PROFILE_API_SERIALIZERS);
	const discovered = model.availableApis?.length ? model.availableApis : (profile.availableApis ?? []);
	const availableApis = Array.from(new Set(discovered)).filter((api) => installed.has(api));

	const modelPreference = explicitPreference(model.apiPreference);
	if (modelPreference) return resolveExplicit(modelPreference, "model", installed, availableApis);

	const familyPreference = model.group
		? explicitPreference(profile.familyApiPreferences?.[model.group.id])
		: undefined;
	if (familyPreference) return resolveExplicit(familyPreference, "family", installed, availableApis);

	if (
		model.gatewayPreferredApi &&
		installed.has(model.gatewayPreferredApi) &&
		(discovered.length === 0 || availableApis.includes(model.gatewayPreferredApi))
	) {
		return { api: model.gatewayPreferredApi, source: "gateway", availableApis };
	}

	const registrySources = options.registrySources ?? [BUILTIN_COMPAT_REGISTRY];
	const registryPreferred = lookupModelCompatOverlay(registrySources, model.id)?.preferredApis ?? [];
	for (const api of registryPreferred) {
		if (installed.has(api) && availableApis.includes(api)) {
			return { api, source: "registry", availableApis };
		}
	}

	const profilePreference = explicitPreference(profile.apiPreference);
	if (profilePreference) return resolveExplicit(profilePreference, "profile", installed, availableApis);

	const fallback = legacyApi(profile);
	if (fallback) return resolveExplicit(fallback, "legacy", installed, availableApis);

	if (availableApis.length === 1) return { api: availableApis[0], source: "available", availableApis };

	return {
		source: "unresolved",
		availableApis,
		reason:
			availableApis.length === 0
				? "No supported API was discovered; select an API for this model"
				: "Multiple APIs are available and no preference resolved; select an API for this model",
	};
}

export function getProfileApiLabel(api: RegistryApi): string {
	if (api === "openai-completions") return "OpenAI Chat Completions";
	if (api === "openai-responses") return "OpenAI Responses";
	if (api === "anthropic-messages") return "Anthropic Messages";
	if (api === "mistral-conversations") return "Mistral Conversations";
	if (api === "openai-codex-responses") return "OpenAI Codex Responses";
	if (api === "google-generative-ai") return "Google Generative AI";
	return "Google Vertex";
}
