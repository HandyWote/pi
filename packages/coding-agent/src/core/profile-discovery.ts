import type { RegistryApi } from "@handy_wote/pi-ai";
import { getOpenRouterThinkingLevelMap, type OpenRouterReasoningMetadata } from "./openrouter-reasoning-options.ts";
import { buildProtocolRoutes, type ProfileAuthStyle, type ProfileProtocolRoute } from "./profile-endpoints.ts";
import type { Profile } from "./profiles-types.ts";

export interface DiscoveredProfileModel {
	id: string;
	name: string;
	availableApis?: RegistryApi[];
	gatewayPreferredApi?: RegistryApi;
	/** Derived from OpenRouter-style reasoning metadata on the catalog entry; takes precedence over models.dev enrich. */
	thinkingLevelMap?: Record<string, string | null>;
}

export interface ProfileDiscoveryCandidate {
	id: string;
	models: DiscoveredProfileModel[];
	availableApis: RegistryApi[];
	protocolRoutes: Partial<Record<RegistryApi, ProfileProtocolRoute>>;
	warnings: string[];
}

export interface ProfileDiscoveryFailure {
	route: Pick<ProfileProtocolRoute, "api" | "catalogUrl" | "inferenceUrl">;
	stage: "catalog" | "inference";
	message: string;
}

export interface ProfileDiscoveryResult {
	candidates: ProfileDiscoveryCandidate[];
	failures: ProfileDiscoveryFailure[];
}

export interface ProfileDiscoveryOptions {
	fetch?: typeof fetch;
	/**
	 * Retained for callers that explicitly want catalog-only diagnostics. Automatic
	 * discovery confirms inference routes by default.
	 */
	probeApis?: boolean;
	timeoutMs?: number;
}

type Catalog = {
	models: DiscoveredProfileModel[];
	availableApis: RegistryApi[];
};

type CatalogRequest = {
	url: string;
	authStyle: ProfileAuthStyle;
	routes: ProfileProtocolRoute[];
};

type CatalogSuccess = CatalogRequest & {
	catalog: Catalog;
};

type CatalogAttempt = {
	request: CatalogRequest;
	catalog?: Catalog;
	error?: unknown;
};

const DEFAULT_TIMEOUT_MS = 10_000;
/** Bounded retries for catalog requests that hang past the per-attempt timeout (df018b602). */
const CATALOG_TIMEOUT_RETRIES = 2;

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
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApi(value: unknown): RegistryApi | undefined {
	return typeof value === "string" ? API_ALIASES[value.trim().toLowerCase()] : undefined;
}

function readApis(record: Record<string, unknown>): RegistryApi[] {
	const rawValues = [
		record.apis,
		record.supported_apis,
		record.supportedApis,
		record.available_apis,
		record.availableApis,
		record.protocols,
	].filter((value) => value !== undefined);
	const values = rawValues.flatMap((raw) => (Array.isArray(raw) ? raw : [raw]));
	return Array.from(new Set(values.map(normalizeApi).filter((api): api is RegistryApi => api !== undefined)));
}

function readPreferredApi(record: Record<string, unknown>): RegistryApi | undefined {
	return normalizeApi(record.preferred_api ?? record.preferredApi ?? record.api ?? record.protocol);
}

function readReasoning(record: Record<string, unknown>): OpenRouterReasoningMetadata | undefined {
	if (!isRecord(record.reasoning)) return undefined;
	const { mandatory, default_enabled, supported_efforts, default_effort } = record.reasoning;
	const isEffort = (value: unknown): value is NonNullable<OpenRouterReasoningMetadata["supported_efforts"]>[number] =>
		typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
	const efforts = Array.isArray(supported_efforts) ? supported_efforts.filter(isEffort) : undefined;
	return {
		...(typeof mandatory === "boolean" ? { mandatory } : {}),
		...(typeof default_enabled === "boolean" ? { default_enabled } : {}),
		...(efforts && efforts.length > 0 ? { supported_efforts: efforts } : {}),
		...(isEffort(default_effort) ? { default_effort } : {}),
	};
}

function parseCatalog(value: unknown): Catalog {
	if (!isRecord(value)) throw new Error("model catalog must be a JSON object");
	const rawModels = value.data ?? value.models;
	if (!Array.isArray(rawModels)) throw new Error("model catalog did not contain a model list");

	const models = rawModels.flatMap((raw): DiscoveredProfileModel[] => {
		if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) return [];
		const availableApis = readApis(raw);
		const gatewayPreferredApi = readPreferredApi(raw);
		const nameValue = raw.name ?? raw.display_name ?? raw.displayName;
		const reasoning = readReasoning(raw);
		const thinkingLevelMap = getOpenRouterThinkingLevelMap(reasoning);
		return [
			{
				id: raw.id,
				name: typeof nameValue === "string" && nameValue.length > 0 ? nameValue : raw.id,
				...(availableApis.length > 0 ? { availableApis } : {}),
				...(gatewayPreferredApi ? { gatewayPreferredApi } : {}),
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			},
		];
	});

	return { models, availableApis: readApis(value) };
}

function authHeaders(profile: Profile, style: ProfileAuthStyle): Record<string, string> {
	if (style === "anthropic") {
		return {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"x-api-key": profile.apiKey,
		};
	}
	return { Authorization: `Bearer ${profile.apiKey}`, "Content-Type": "application/json" };
}

function failureRoute(route: ProfileProtocolRoute): ProfileDiscoveryFailure["route"] {
	return { api: route.api, catalogUrl: route.catalogUrl, inferenceUrl: route.inferenceUrl };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseJsonBody(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function hasStructuredProtocolError(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const error = value.error;
	if (!isRecord(error)) return false;
	return [error.type, error.code, error.message, error.param, error.status].some(
		(field) => typeof field === "string" || typeof field === "number",
	);
}

function routeSupportsApi(catalog: Catalog, api: RegistryApi): boolean {
	return catalog.availableApis.length === 0 || catalog.availableApis.includes(api);
}

function modelsKey(models: DiscoveredProfileModel[]): string {
	return JSON.stringify(
		models
			.map((model) => ({
				id: model.id,
				name: model.name,
				availableApis: model.availableApis,
				gatewayPreferredApi: model.gatewayPreferredApi,
				thinkingLevelMap: model.thinkingLevelMap,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}

function candidateKey(catalog: CatalogSuccess): string {
	return `${catalog.url}\u0000${modelsKey(catalog.catalog.models)}`;
}

function withTimeout(init: RequestInit, timeoutMs: number): { init: RequestInit; cancel: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return {
		init: { ...init, signal: controller.signal },
		cancel: () => clearTimeout(timer),
	};
}

/** Fetch once with a fresh per-attempt timeout, retrying hung (timed-out) requests. */
async function fetchWithTimeoutRetry(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	retriesOnTimeout: number,
): Promise<Response> {
	for (let attempt = 0; ; attempt += 1) {
		const timed = withTimeout(init, timeoutMs);
		try {
			return await fetchImpl(url, timed.init);
		} catch (error) {
			const isTimeout = error instanceof Error && error.name === "AbortError";
			if (!isTimeout || attempt >= retriesOnTimeout) throw error;
			// Hung request: retry with a fresh per-attempt timeout.
		} finally {
			timed.cancel();
		}
	}
}

/** Fetch a URL while allowing at most one same-origin redirect. */
async function fetchSameOrigin(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	followSameOriginRedirect = true,
	retriesOnTimeout = 0,
): Promise<Response> {
	let currentUrl = url;
	for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
		const response = await fetchWithTimeoutRetry(
			fetchImpl,
			currentUrl,
			{ ...init, redirect: "manual" },
			timeoutMs,
			retriesOnTimeout,
		);
		if (response.status < 300 || response.status >= 400) return response;
		if (!followSameOriginRedirect) return response;
		const location = response.headers.get("location");
		if (!location) throw new Error(`redirect response ${response.status} did not include a Location header`);
		const nextUrl = new URL(location, currentUrl);
		const origin = new URL(currentUrl).origin;
		if (nextUrl.origin !== origin) throw new Error("cross-origin redirect refused");
		if (nextUrl.username || nextUrl.password) throw new Error("redirect URL must not contain credentials");
		if (redirectCount === 1) throw new Error("more than one redirect refused");
		currentUrl = nextUrl.toString();
	}
	throw new Error("redirect failed");
}

async function fetchCatalog(
	profile: Profile,
	request: CatalogRequest,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<Catalog> {
	const response = await fetchSameOrigin(
		fetchImpl,
		request.url,
		{ method: "GET", headers: authHeaders(profile, request.authStyle) },
		timeoutMs,
		true,
		CATALOG_TIMEOUT_RETRIES,
	);
	if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
	return parseCatalog(await response.json());
}

async function verifyInferenceRoute(
	profile: Profile,
	route: ProfileProtocolRoute,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<{ confirmed: boolean; warning?: string; failure?: string }> {
	let response: Response;
	try {
		response = await fetchSameOrigin(
			fetchImpl,
			route.inferenceUrl,
			{ method: "POST", headers: authHeaders(profile, route.authStyle), body: "{}" },
			timeoutMs,
			false,
		);
	} catch (error) {
		return { confirmed: false, failure: describeError(error) };
	}

	if (response.status === 400 || response.status === 415 || response.status === 422 || response.status === 429) {
		const body = parseJsonBody(await response.text());
		if (hasStructuredProtocolError(body)) {
			return response.status === 429
				? { confirmed: true, warning: "inference route responded with a structured rate-limit error" }
				: { confirmed: true };
		}
		return { confirmed: false, failure: `HTTP ${response.status} with an unrecognized error response` };
	}
	if (response.status === 401 || response.status === 403)
		return { confirmed: false, failure: `HTTP ${response.status} (authentication failed)` };
	if (response.status >= 300 && response.status < 400)
		return { confirmed: false, failure: `HTTP ${response.status} (redirect not followed)` };
	if (response.status >= 500) return { confirmed: false, failure: `HTTP ${response.status} (server error)` };
	if (response.status === 404 || response.status === 405)
		return { confirmed: false, failure: `HTTP ${response.status}` };
	if (response.ok)
		return { confirmed: false, failure: `HTTP ${response.status} (unexpected success for empty request)` };
	return { confirmed: false, failure: `HTTP ${response.status}` };
}

/** Verify a manually configured standard-protocol route without sending a prompt. */
export async function verifyProfileRoute(
	profile: Profile,
	route: ProfileProtocolRoute,
	options: Pick<ProfileDiscoveryOptions, "fetch" | "timeoutMs"> = {},
): Promise<{ confirmed: boolean; warning?: string; failure?: string }> {
	return verifyInferenceRoute(profile, route, options.fetch ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function discoverProfile(
	profile: Profile,
	options: ProfileDiscoveryOptions = {},
): Promise<ProfileDiscoveryResult> {
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const failures: ProfileDiscoveryFailure[] = [];
	let routes: ProfileProtocolRoute[];
	try {
		routes = buildProtocolRoutes(profile.baseUrl);
	} catch (error) {
		return {
			candidates: [],
			failures: [
				{
					route: { api: "openai-completions", catalogUrl: profile.baseUrl, inferenceUrl: profile.baseUrl },
					stage: "catalog",
					message: describeError(error),
				},
			],
		};
	}

	const catalogRequests = new Map<string, CatalogRequest>();
	for (const route of routes) {
		const key = `${route.catalogUrl}\u0000${route.authStyle}`;
		const existing = catalogRequests.get(key);
		if (existing) existing.routes.push(route);
		else catalogRequests.set(key, { url: route.catalogUrl, authStyle: route.authStyle, routes: [route] });
	}

	const catalogAttempts = await Promise.all(
		Array.from(catalogRequests.values()).map(async (request): Promise<CatalogAttempt> => {
			try {
				return { request, catalog: await fetchCatalog(profile, request, fetchImpl, timeoutMs) };
			} catch (error) {
				return { request, error };
			}
		}),
	);
	const catalogResults: CatalogSuccess[] = [];
	for (const attempt of catalogAttempts) {
		if ("error" in attempt) {
			for (const route of attempt.request.routes) {
				failures.push({
					route: failureRoute(route),
					stage: "catalog",
					message: describeError(attempt.error),
				});
			}
		} else if (attempt.catalog) {
			catalogResults.push({ ...attempt.request, catalog: attempt.catalog });
		}
	}

	const candidateMap = new Map<string, ProfileDiscoveryCandidate>();
	for (const catalogSuccess of catalogResults) {
		const candidateRoutes = catalogSuccess.routes.filter((route) =>
			routeSupportsApi(catalogSuccess.catalog, route.api),
		);
		const verifiedRoutes: ProfileProtocolRoute[] = [];
		const warnings: string[] = [];
		for (const route of candidateRoutes) {
			if (options.probeApis === false) {
				verifiedRoutes.push(route);
				continue;
			}
			const verification = await verifyInferenceRoute(profile, route, fetchImpl, timeoutMs);
			if (verification.confirmed) {
				verifiedRoutes.push(route);
				if (verification.warning) warnings.push(`${route.api}: ${verification.warning}`);
			} else {
				failures.push({
					route: failureRoute(route),
					stage: "inference",
					message: verification.failure ?? "route was not confirmed",
				});
			}
		}
		if (verifiedRoutes.length === 0) continue;

		const key = candidateKey(catalogSuccess);
		const existing = candidateMap.get(key);
		if (existing) {
			for (const route of verifiedRoutes) existing.protocolRoutes[route.api] = route;
			existing.availableApis = Array.from(
				new Set([...existing.availableApis, ...verifiedRoutes.map((route) => route.api)]),
			);
			for (const model of catalogSuccess.catalog.models) {
				const existingModel = existing.models.find((candidateModel) => candidateModel.id === model.id);
				if (!existingModel) continue;
				const modelApis = model.availableApis ?? verifiedRoutes.map((route) => route.api);
				existingModel.availableApis = Array.from(new Set([...(existingModel.availableApis ?? []), ...modelApis]));
			}
			existing.warnings.push(...warnings);
			continue;
		}
		candidateMap.set(key, {
			id: key,
			models: catalogSuccess.catalog.models.map((model) => ({
				...model,
				...(model.availableApis
					? {
							availableApis: model.availableApis.filter((api) =>
								verifiedRoutes.some((route) => route.api === api),
							),
						}
					: { availableApis: verifiedRoutes.map((route) => route.api) }),
			})),
			availableApis: verifiedRoutes.map((route) => route.api),
			protocolRoutes: Object.fromEntries(verifiedRoutes.map((route) => [route.api, route])),
			warnings: [...(catalogSuccess.catalog.models.length === 0 ? ["model catalog is empty"] : []), ...warnings],
		});
	}

	const candidates = Array.from(candidateMap.values()).sort((a, b) => a.id.localeCompare(b.id));
	failures.sort((a, b) => {
		const left = `${a.route.api}\u0000${a.stage}\u0000${a.route.catalogUrl}\u0000${a.message}`;
		const right = `${b.route.api}\u0000${b.stage}\u0000${b.route.catalogUrl}\u0000${b.message}`;
		return left.localeCompare(right);
	});
	return { candidates, failures };
}
