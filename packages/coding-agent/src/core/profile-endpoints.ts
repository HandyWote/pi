import type { RegistryApi } from "@handy_wote/pi-ai";

/** The authentication header family used by a protocol route. */
export type ProfileAuthStyle = "openai" | "anthropic";

export interface ProfileProtocolRoute {
	api: RegistryApi;
	/** Base URL passed to this API's serializer or SDK. */
	sdkBaseUrl: string;
	/** Full non-secret URL used only for catalog discovery. */
	catalogUrl: string;
	/** Full non-secret URL used for no-generation route verification. */
	inferenceUrl: string;
	authStyle: ProfileAuthStyle;
}

export type ProfileDiscoveryApi = "anthropic-messages" | "openai-completions" | "openai-responses";

interface ProtocolDefinition {
	api: ProfileDiscoveryApi;
	inferencePath: string;
	manualInferencePath: string;
	manualCatalogPath: string;
	authStyle: ProfileAuthStyle;
	openAiSdkBase: boolean;
}

const PROTOCOL_DEFINITIONS: readonly ProtocolDefinition[] = [
	{
		api: "openai-completions",
		inferencePath: "v1/chat/completions",
		manualInferencePath: "chat/completions",
		manualCatalogPath: "models",
		authStyle: "openai",
		openAiSdkBase: true,
	},
	{
		api: "openai-responses",
		inferencePath: "v1/responses",
		manualInferencePath: "responses",
		manualCatalogPath: "models",
		authStyle: "openai",
		openAiSdkBase: true,
	},
	{
		api: "anthropic-messages",
		inferencePath: "v1/messages",
		manualInferencePath: "v1/messages",
		manualCatalogPath: "v1/models",
		authStyle: "anthropic",
		openAiSdkBase: false,
	},
];

const AUTOMATIC_RESOURCE_TAILS = [
	["v1"],
	["v1beta"],
	["models"],
	["messages"],
	["responses"],
	["chat", "completions"],
	["conversations"],
] as const;

function parseProfileRootUrl(value: string): URL {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Profile root URL is required");

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Profile root URL must be a valid absolute URL");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Profile root URL must use http or https");
	}
	if (url.username || url.password) {
		throw new Error("Profile root URL must not contain a username or password");
	}
	return url;
}

function urlString(url: URL): string {
	const pathname = url.pathname.replace(/\/+$/u, "");
	return `${url.origin}${pathname}${url.search}${url.hash}`;
}

function withPath(rootUrl: string, suffix: string): string {
	const url = parseProfileRootUrl(rootUrl);
	const pathname = url.pathname.replace(/\/+$/u, "");
	url.pathname = `${pathname}/${suffix}`;
	return urlString(url);
}

function hasAutomaticResourceTail(pathname: string): boolean {
	const segments = pathname
		.replace(/\/+$/u, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => segment.toLowerCase());
	return AUTOMATIC_RESOURCE_TAILS.some(
		(tail) =>
			tail.length <= segments.length &&
			tail.every((segment, index) => segments[segments.length - tail.length + index] === segment),
	);
}

/**
 * Parse and normalize a Profile root URL. Only redundant pathname slashes are
 * removed; the URL's origin, path prefix, query and fragment are retained.
 */
export function normalizeProfileRootUrl(value: string): string {
	return urlString(parseProfileRootUrl(value));
}

/** Validate the URL form accepted by automatic protocol discovery. */
export function validateAutomaticProfileRootUrl(value: string): string {
	const url = parseProfileRootUrl(value);
	if (hasAutomaticResourceTail(url.pathname)) {
		throw new Error(
			"Automatic Profile discovery requires a service root URL; remove the trailing /v1, /models, /messages, /responses, or API resource path",
		);
	}
	return urlString(url);
}

/** Build the finite set of protocol routes supported by automatic discovery. */
export function buildProtocolRoutes(rootUrl: string): ProfileProtocolRoute[] {
	const normalizedRoot = validateAutomaticProfileRootUrl(rootUrl);
	const routes = PROTOCOL_DEFINITIONS.map(
		(definition): ProfileProtocolRoute => ({
			api: definition.api,
			sdkBaseUrl: definition.openAiSdkBase ? withPath(normalizedRoot, "v1") : normalizedRoot,
			catalogUrl: withPath(normalizedRoot, "v1/models"),
			inferenceUrl: withPath(normalizedRoot, definition.inferencePath),
			authStyle: definition.authStyle,
		}),
	);

	const seen = new Set<string>();
	return routes.filter((route) => {
		const key = [route.api, route.catalogUrl, route.inferenceUrl, route.sdkBaseUrl, route.authStyle].join("\u0000");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Build a route from a serializer/SDK base URL supplied in manual mode. */
export function buildManualProtocolRoute(api: ProfileDiscoveryApi, sdkBaseUrl: string): ProfileProtocolRoute {
	const definition = PROTOCOL_DEFINITIONS.find((candidate) => candidate.api === api);
	if (!definition) throw new Error(`Unsupported automatic Profile API: ${api}`);
	const normalizedBase = normalizeProfileRootUrl(sdkBaseUrl);
	return {
		api,
		sdkBaseUrl: normalizedBase,
		catalogUrl: withPath(normalizedBase, definition.manualCatalogPath),
		inferenceUrl: withPath(normalizedBase, definition.manualInferencePath),
		authStyle: definition.authStyle,
	};
}
