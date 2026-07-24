import type { Api, Model } from "@handy_wote/pi-ai";

export interface ModelReference {
	provider: string;
	modelId: string;
}

export function formatModelReference(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelReference(value: string): ModelReference | undefined {
	const trimmed = value.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slashIndex),
		modelId: trimmed.slice(slashIndex + 1),
	};
}

export function getModelReferenceSearchText(model: Pick<Model<Api>, "provider" | "id" | "name">): string {
	return `${formatModelReference(model)} ${model.name ?? ""}`;
}
