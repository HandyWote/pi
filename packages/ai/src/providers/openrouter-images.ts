import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IMAGE_MODELS: Record<string, Record<string, any>> = { openrouter: {} };

import { createImagesProvider, type ImagesProvider } from "../images-models.ts";

export function openrouterImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openrouter",
		name: "OpenRouter",
		auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
		models: Object.values(IMAGE_MODELS.openrouter),
		api: openrouterImagesApi(),
	});
}
