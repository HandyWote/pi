export { anthropicCompatProvider } from "./anthropic-compat.ts";
export { openAICompatProvider } from "./openai-compat.ts";
export { radiusProvider } from "./radius.ts";

/** @deprecated Stub — use profiles instead. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function builtinProviders(): any[] {
	return [];
}
