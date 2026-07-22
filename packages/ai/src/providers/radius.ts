import { piMessagesApi } from "../api/pi-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { Provider } from "../models.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFAULT_RADIUS_GATEWAY = "https://radius.pi.dev";
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
function getRadiusModels(_providerId: string, _credential: any): any[] {
	return [];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
function getRadiusModelsFromConfig(_providerId: string, _config: any): any[] {
	return [];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
async function loadRadiusGatewayConfig(_gateway: string, _apiKey: any, _signal: any): Promise<any> {
	return {};
}
function normalizeRadiusGatewayUrl(url: string): string {
	return url;
}

export interface RadiusProviderOptions {
	id?: string;
	name?: string;
	gateway?: string;
}

/** Radius gateway provider with a persisted, dynamically refreshed catalog. */
export function radiusProvider(options: RadiusProviderOptions = {}): Provider<"pi-messages"> {
	const id = options.id ?? "radius";
	const name = options.name ?? "Radius";
	const gateway = normalizeRadiusGatewayUrl(options.gateway ?? DEFAULT_RADIUS_GATEWAY);
	let models = getRadiusModels(id, undefined);
	let inflightRefresh: Promise<void> | undefined;
	const streams = piMessagesApi();

	return {
		id,
		name,
		auth: {
			apiKey: envApiKeyAuth("Radius API key", ["RADIUS_API_KEY"]),
		},
		getModels: () => models,
		refreshModels: (context) => {
			inflightRefresh ??= (async () => {
				try {
					const stored = await context.store.read();
					if (stored) models = stored.models.filter((model) => model.provider === id) as typeof models;

					if (!context.allowNetwork || context.signal?.aborted) return;
					const config = await loadRadiusGatewayConfig(gateway, context.credential?.key, context.signal);
					if (context.signal?.aborted) return;
					models = getRadiusModelsFromConfig(id, config);
					await context.store.write({ models, checkedAt: Date.now() });
				} finally {
					inflightRefresh = undefined;
				}
			})();
			return inflightRefresh;
		},
		stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, streamOptions),
	};
}
