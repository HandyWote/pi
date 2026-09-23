/**
 * Profile-state -> official models.json compiler.
 *
 * profile-state.json is the profile management source of truth (profile
 * declarations plus management semantics that official models.json cannot
 * express). This module compiles every profile's enabled, routable models
 * into the official models.json provider/model vocabulary so the official pi
 * runtime can execute requests without any profile-specific protocol.
 *
 * Invariants (per docs/plans profile plugin decisions):
 * - Raw gateway model IDs are preserved verbatim as the compiled model id;
 *   they are request IDs and never rewritten.
 * - A profile maps to exactly one stable provider ID, never derived from the
 *   display name.
 * - One selected API route per model (no failover lines compiled).
 * - Official models.json has no model-level baseUrl. A Profile's saved URL
 *   may be a gateway root while an OpenAI-compatible route lives at `/v1`.
 *   That standard suffix is compiled as the provider endpoint. Any other
 *   route URL must be the same gateway endpoint or it is skipped.
 * - Routing preferences and profile-only state stay out of models.json.
 * - No plaintext API keys: auth references are produced by ./auth.ts.
 * - Write side is atomic (temp file + rename) so a crash never leaves a
 *   truncated models.json.
 *
 * Input field mapping (profile-state.json vocabulary -> official vocabulary):
 * - `supportsReasoning` compiles to the official `reasoning` boolean.
 * - `supportsVision` compiles to the official `input` list
 *   (`["text","image"]` when true, `["text"]` otherwise).
 *
 * Pure compiler: reads nothing, watches nothing, renders nothing. The caller
 * passes profile state in and receives the compiled document (and optionally
 * persists it via writeModelsJson).
 */

import type { AuthReference } from "./auth.ts";
import { checkAuthAssociation, modelsJsonApiKey } from "./auth.ts";

/** API types this compiler can emit into models.json. */
export const COMPILABLE_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export type CompilableApi = (typeof COMPILABLE_APIS)[number];

/** Input: the profile declaration stored in profile-state.json. */
export interface CompilerProfileInput {
	/** Stable provider ID; must not change when the display name changes. */
	id: string;
	/** Display name; used only for the compiled provider `name`. */
	name: string;
	baseUrl: string;
	/** Optional extra headers applied to the compiled provider entry. */
	headers?: Record<string, string>;
	/**
	 * auth.json association. When set, the compiled provider entry carries no
	 * `apiKey` and the official runtime resolves the credential from auth.json.
	 */
	authProviderId?: string;
	/**
	 * Explicit key reference (`$VAR`, `!cmd`) when auth.json is not used.
	 * Plaintext keys are rejected by the compiler.
	 */
	authReference?: AuthReference;
	/** Models declared for this profile; only enabled+available ones compile. */
	models: CompilerModelInput[];
}

/** Per-model API route entry from profile-state.json. */
export interface CompilerApiRouteInput {
	/**
	 * Base URL passed to this API's serializer. A route may add the standard
	 * `/v1` suffix to the saved gateway root; other endpoints are not
	 * representable by a one-provider models.json entry.
	 */
	sdkBaseUrl: string;
	/** Whether this route was verified by discovery or manual verification. */
	verified?: boolean;
}

/** Input: a model as tracked in profile-state.json (UserModel vocabulary). */
export interface CompilerModelInput {
	/** Raw gateway model ID; compiled verbatim as the models.json model id. */
	id: string;
	name: string;
	/** Management flag; disabled models are excluded from the compiled output. */
	enabled: boolean;
	/** Management flag; unavailable models are excluded from the compiled output. */
	available?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	/** Profile-state capability flags; compiled to `reasoning`/`input`. */
	supportsReasoning?: boolean;
	supportsVision?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	cost?: ModelCostInput;
	/** User overrides; highest capability precedence, flattened into the entry. */
	overrides?: CompilerModelOverridesInput;
	/** Discovered per-model routes; keys are API types. */
	apiRoutes?: Partial<Record<CompilableApi, CompilerApiRouteInput>>;
	/** Route preference resolution inputs, evaluated model > family > gateway > profile. */
	apiPreference?: string;
	familyApiPreferences?: Record<string, string>;
	gatewayPreferredApi?: string;
	profileApiPreference?: string;
	profileProtocol?: "openai" | "anthropic";
	/**
	 * APIs discovered as usable for this model (already filtered by the caller
	 * to installed serializers and configured routes).
	 */
	availableApis?: readonly CompilableApi[];
	/** Extra fields merged verbatim into the compiled model entry. */
	extra?: Record<string, unknown>;
}

export interface ModelCostInput {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	tiers?: Array<ModelCostInput & { inputTokensAbove: number }>;
}

/** Overrides use the same profile-state capability vocabulary as UserModel. */
export interface CompilerModelOverridesInput {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsReasoning?: boolean;
	supportsVision?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	cost?: Partial<ModelCostInput>;
	/** APIs the user pinned for this model; validated against configured routes. */
	apis?: Partial<Record<CompilableApi, { compat?: Record<string, unknown> }>>;
}

/** Output: compiled models.json document in the official schema. */
export interface CompiledModelsJson {
	providers: Record<
		string,
		{
			name: string;
			baseUrl: string;
			headers?: Record<string, string>;
			apiKey?: string;
			api?: CompilableApi;
			models: CompiledModelEntry[];
		}
	>;
}

export interface CompiledModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: ModelCostInput;
	input: Array<"text" | "image">;
	thinkingLevelMap?: Record<string, string | null>;
	api?: CompilableApi;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface CompileDiagnostic {
	severity: "warning" | "error";
	message: string;
	profileId?: string;
	modelId?: string;
}

export interface CompileResult {
	doc: CompiledModelsJson;
	diagnostics: CompileDiagnostic[];
}

export interface CompileProfilesOptions {
	/** Restrict compilation to these profile IDs. */
	profileIds?: readonly string[];
	/** Compile disabled/unavailable models too (testing/inspection only). */
	includeDisabled?: boolean;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Provider IDs become models.json record keys and the first component of the
 * canonical `provider/model` reference, so they must be non-empty and must
 * not contain whitespace or `/` (which would make the reference ambiguous).
 */
export function isValidProviderId(id: string): boolean {
	return typeof id === "string" && id.length > 0 && !/[\s/]/.test(id);
}

/**
 * Complete a cost object to the official shape: models.json requires all four
 * rates as numbers whenever `cost` is present, and every tier requires the
 * four rates plus `inputTokensAbove`. Partial profile-state cost input would
 * otherwise make the whole models.json fail official schema validation.
 */
export function normalizeModelCost(input: ModelCostInput | undefined): ModelCostInput {
	const tiers = (input?.tiers ?? []).flatMap((tier) =>
		Number.isFinite(tier.inputTokensAbove)
			? [
					{
						inputTokensAbove: tier.inputTokensAbove,
						input: tier.input ?? 0,
						output: tier.output ?? 0,
						cacheRead: tier.cacheRead ?? 0,
						cacheWrite: tier.cacheWrite ?? 0,
					},
				]
			: [],
	);
	return {
		input: input?.input ?? 0,
		output: input?.output ?? 0,
		cacheRead: input?.cacheRead ?? 0,
		cacheWrite: input?.cacheWrite ?? 0,
		...(tiers.length > 0 ? { tiers } : {}),
	};
}

/** Resolve an optional positive numeric field, returning undefined when invalid. */
function resolvePositive(value: number | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Normalize a base URL for equivalence checks: lowercase scheme/host, strip
 * default ports and trailing slashes. Unparseable values fall back to a
 * trimmed, trailing-slash-stripped string.
 */
export function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	try {
		const parsed = new URL(trimmed);
		const isDefaultPort =
			(parsed.protocol === "https:" && parsed.port === "443") ||
			(parsed.protocol === "http:" && parsed.port === "80");
		const host = isDefaultPort ? parsed.hostname : parsed.host;
		return `${parsed.protocol}//${host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
	} catch {
		return trimmed;
	}
}

function isBaseUrlEquivalent(a: string, b: string): boolean {
	return normalizeBaseUrl(a) === normalizeBaseUrl(b);
}

/**
 * A profile stores the gateway root for a stable, protocol-neutral UI.
 * OpenAI-compatible gateways commonly expose their API below that root at
 * `/v1`, which must become the compiled provider URL for the official SDK.
 */
function isProfileRouteBaseUrlCompatible(profileBaseUrl: string, routeBaseUrl: string): boolean {
	const normalizedProfile = normalizeBaseUrl(profileBaseUrl);
	const normalizedRoute = normalizeBaseUrl(routeBaseUrl);
	return normalizedRoute === normalizedProfile || normalizedRoute === `${normalizedProfile}/v1`;
}

function explicitPreference(preference: string | undefined): CompilableApi | undefined {
	if (!preference || preference === "auto") return undefined;
	return preference as CompilableApi;
}

/**
 * Select the single API route compiled for a model.
 * Precedence: model > family > gateway discovery > profile > legacy protocol
 * > single available API. Preferences that name an API without a configured
 * route (or an uncompilable API) are skipped.
 */
export function selectModelApi(
	model: Pick<
		CompilerModelInput,
		| "apiRoutes"
		| "apiPreference"
		| "familyApiPreferences"
		| "gatewayPreferredApi"
		| "profileApiPreference"
		| "profileProtocol"
		| "availableApis"
	>,
	familyId?: string,
): { api?: CompilableApi; source: string } {
	const configuredRoutes = model.apiRoutes
		? (Object.keys(model.apiRoutes) as CompilableApi[]).filter((api) => COMPILABLE_APIS.includes(api))
		: [];
	const configured = new Set(configuredRoutes);
	const discovered = (model.availableApis ?? []).filter((api) => COMPILABLE_APIS.includes(api));
	const usable = discovered.length ? discovered.filter((api) => configured.has(api)) : configuredRoutes;

	const resolveExplicit = (api: CompilableApi | undefined, source: string) => {
		if (!api) return undefined;
		if (!COMPILABLE_APIS.includes(api)) return undefined;
		if (configured.size && !configured.has(api)) return undefined;
		return { api, source };
	};

	const attempts: Array<{ api?: CompilableApi; source: string }> = [
		{ api: explicitPreference(model.apiPreference), source: "model" },
		{
			api: familyId ? explicitPreference(model.familyApiPreferences?.[familyId]) : undefined,
			source: "family",
		},
		{ api: explicitPreference(model.gatewayPreferredApi), source: "gateway" },
		{ api: explicitPreference(model.profileApiPreference), source: "profile" },
		{
			api:
				model.profileProtocol === "anthropic"
					? "anthropic-messages"
					: model.profileProtocol === "openai"
						? "openai-completions"
						: undefined,
			source: "legacy",
		},
	];

	for (const attempt of attempts) {
		const resolved = resolveExplicit(attempt.api, attempt.source);
		if (resolved) return resolved;
	}

	if (usable.length === 1) return { api: usable[0], source: "available" };
	return { api: undefined, source: usable.length === 0 ? "unresolved-empty" : "unresolved-ambiguous" };
}

/** Compile the profile-state capability flags into official model vocabulary. */
function compileCapabilities(
	supportsReasoning: boolean | undefined,
	supportsVision: boolean | undefined,
): { reasoning: boolean; input: Array<"text" | "image"> } {
	return {
		reasoning: supportsReasoning === true,
		input: supportsVision === true ? ["text", "image"] : ["text"],
	};
}

function applyOverrides(entry: CompiledModelEntry, overrides: CompilerModelOverridesInput | undefined): void {
	if (!overrides) return;
	if (overrides.name !== undefined) entry.name = overrides.name.trim() || String(entry.id);
	if (overrides.contextWindow !== undefined) entry.contextWindow = overrides.contextWindow;
	if (overrides.maxTokens !== undefined) entry.maxTokens = overrides.maxTokens;
	if (overrides.supportsReasoning !== undefined) entry.reasoning = overrides.supportsReasoning;
	if (overrides.supportsVision !== undefined) entry.input = compileCapabilities(true, overrides.supportsVision).input;
	if (overrides.thinkingLevelMap !== undefined) entry.thinkingLevelMap = { ...overrides.thinkingLevelMap };
	if (overrides.cost !== undefined) entry.cost = normalizeModelCost({ ...entry.cost, ...overrides.cost });
}

/**
 * Compile profile state into a full models.json document.
 *
 * All profiles' enabled, routable models compile into one document; users
 * pick among them with the official /model entry. Profiles whose models all
 * fail compilation produce a diagnostic and no provider entry.
 */
export function compileProfiles(
	profiles: readonly CompilerProfileInput[],
	options: CompileProfilesOptions = {},
): CompileResult {
	const diagnostics: CompileDiagnostic[] = [];
	const providers: CompiledModelsJson["providers"] = {};

	for (const profile of profiles) {
		if (options.profileIds && !options.profileIds.includes(profile.id)) continue;

		if (!isValidProviderId(profile.id)) {
			diagnostics.push({
				severity: "error",
				profileId: profile.id,
				message: `profile id "${profile.id}" is not a valid models.json provider id: it must be non-empty and must not contain whitespace or "/"; profile skipped`,
			});
			continue;
		}
		if (typeof profile.baseUrl !== "string" || profile.baseUrl.trim().length === 0) {
			diagnostics.push({
				severity: "error",
				profileId: profile.id,
				message: `profile "${profile.id}" has no baseUrl; official models.json requires a baseUrl for custom providers; profile skipped`,
			});
			continue;
		}
		diagnostics.push(...checkAuthAssociation(profile));

		const models: CompiledModelEntry[] = [];
		const seenModelIds = new Set<string>();
		let compiledBaseUrl: string | undefined;
		for (const model of profile.models) {
			const routable = options.includeDisabled ? true : model.enabled && model.available !== false;
			if (!routable) continue;

			if (typeof model.id !== "string" || model.id.trim().length === 0) {
				diagnostics.push({
					severity: "error",
					profileId: profile.id,
					message: `profile "${profile.id}" has a model with an empty id; official models.json requires a non-empty model id; model skipped`,
				});
				continue;
			}
			if (seenModelIds.has(model.id)) {
				diagnostics.push({
					severity: "warning",
					profileId: profile.id,
					modelId: model.id,
					message: `model "${model.id}" is declared more than once; official models.json upserts by id, so the duplicate is skipped`,
				});
				continue;
			}
			seenModelIds.add(model.id);

			const familyId =
				model.overrides && "familyId" in model.overrides
					? String((model.overrides as Record<string, unknown>).familyId)
					: undefined;
			const { api, source } = selectModelApi(model, familyId);
			if (!api) {
				diagnostics.push({
					severity: source === "unresolved-empty" ? "warning" : "error",
					profileId: profile.id,
					modelId: model.id,
					message:
						source === "unresolved-empty"
							? `model "${model.id}" has no configured compilable API route; skipped`
							: `model "${model.id}" has ambiguous API routes and no resolving preference; skipped`,
				});
				continue;
			}

			const route = model.apiRoutes?.[api];
			if (route && !isProfileRouteBaseUrlCompatible(profile.baseUrl, route.sdkBaseUrl)) {
				diagnostics.push({
					severity: "error",
					profileId: profile.id,
					modelId: model.id,
					message: `model "${model.id}" ${api} route sdkBaseUrl "${route.sdkBaseUrl}" is not the profile baseUrl "${profile.baseUrl}" or its standard /v1 endpoint; official models.json has no model-level baseUrl, so this route cannot compile; skipped`,
				});
				continue;
			}
			if (route && compiledBaseUrl && !isBaseUrlEquivalent(route.sdkBaseUrl, compiledBaseUrl)) {
				diagnostics.push({
					severity: "error",
					profileId: profile.id,
					modelId: model.id,
					message: `model "${model.id}" ${api} route sdkBaseUrl "${route.sdkBaseUrl}" differs from this profile's compiled provider endpoint "${compiledBaseUrl}"; official models.json has no model-level baseUrl, so this route cannot compile; skipped`,
				});
				continue;
			}
			if (route) compiledBaseUrl ??= route.sdkBaseUrl;

			const contextWindow = resolvePositive(
				model.overrides?.contextWindow ?? model.contextWindow,
				DEFAULT_CONTEXT_WINDOW,
			);
			const maxTokens = resolvePositive(model.overrides?.maxTokens ?? model.maxTokens, DEFAULT_MAX_TOKENS);
			if (contextWindow === undefined || maxTokens === undefined) {
				diagnostics.push({
					severity: "error",
					profileId: profile.id,
					modelId: model.id,
					message: `model "${model.id}" has a non-positive contextWindow or maxTokens; official models.json rejects it; skipped`,
				});
				continue;
			}

			const capabilities = compileCapabilities(model.supportsReasoning, model.supportsVision);
			const entry: CompiledModelEntry = {
				...(model.extra ?? {}),
				id: model.id,
				name: model.overrides?.name?.trim() || model.name?.trim() || model.id,
				reasoning: model.overrides?.supportsReasoning ?? capabilities.reasoning,
				input: capabilities.input,
				contextWindow,
				maxTokens,
				cost: normalizeModelCost(model.cost),
				...(model.thinkingLevelMap || model.overrides?.thinkingLevelMap
					? {
							thinkingLevelMap: {
								...(model.thinkingLevelMap ?? {}),
								...(model.overrides?.thinkingLevelMap ?? {}),
							},
						}
					: {}),
				api,
			};
			applyOverrides(entry, model.overrides);

			// Generic OpenAI-compatible gateways frequently reject the developer role.
			// Preserve an explicit model override for gateways that support it.
			const defaultCompat = api === "openai-completions" ? { supportsDeveloperRole: false } : undefined;
			const pinnedCompat = model.overrides?.apis?.[api]?.compat;
			if (defaultCompat || pinnedCompat) entry.compat = { ...defaultCompat, ...pinnedCompat };

			models.push(entry);
		}

		if (models.length === 0) continue;

		providers[profile.id] = {
			name: profile.name?.trim() || profile.id,
			baseUrl: compiledBaseUrl ?? profile.baseUrl,
			...(profile.headers && Object.keys(profile.headers).length ? { headers: profile.headers } : {}),
			apiKey: modelsJsonApiKey(profile),
			models,
		};
	}

	return { doc: { providers }, diagnostics };
}

/** Serialize a compiled document to models.json file content. */
export function serializeModelsJson(doc: CompiledModelsJson): string {
	return `${JSON.stringify(doc, null, "\t")}\n`;
}

/**
 * Merge compiled profile providers into an existing models.json document.
 * Profile providers are keyed by stable provider ID and replace prior entries
 * with the same key; non-profile (built-in override) entries are preserved.
 */
/**
 * Merge compiled profile providers into an existing models.json document.
 *
 * Ownership is explicit: `staleProviderIds` are the provider IDs the profile
 * compiler generated on a previous compile that are no longer produced (a
 * profile was deleted, renamed, or now has zero routable models). Only those
 * IDs are removed. Every other existing entry is preserved verbatim, so
 * user-owned custom providers and built-in overrides are never deleted even
 * if they happen to look like compiled entries.
 *
 * `staleProviderIds` defaults to empty for callers that only want to upsert.
 */
export function mergeIntoModelsJson(
	existing: unknown,
	compiled: CompiledModelsJson,
	staleProviderIds: readonly string[] = [],
): CompiledModelsJson {
	const base =
		existing && typeof existing === "object" && "providers" in (existing as Record<string, unknown>)
			? ((existing as { providers?: Record<string, unknown> }).providers ?? {})
			: {};
	const stale = new Set(staleProviderIds);
	const providers: Record<string, unknown> = {};
	for (const [id, provider] of Object.entries(base)) {
		if (stale.has(id)) continue;
		providers[id] = provider;
	}
	for (const [id, provider] of Object.entries(compiled.providers)) {
		providers[id] = provider;
	}
	// Preserve any other top-level keys a user may have in models.json; only
	// `providers` is managed by the compiler.
	const documentBase =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? { ...(existing as Record<string, unknown>) }
			: {};
	return { ...documentBase, providers } as unknown as CompiledModelsJson;
}
