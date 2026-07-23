export { BUILTIN_COMPAT_REGISTRY } from "./builtin.ts";
export { lookupCompatOverlay, lookupModelCompatOverlay, mergeModelCompatOverlays } from "./merge.ts";
export * from "./types.ts";
export type { CompatRegistryValidationIssue, CompatRegistryValidationResult } from "./validation.ts";
export {
	CompatRegistryValidationError,
	compileCompatRegistry,
	ModelCompatRegistrySchema,
	validateCompatRegistry,
} from "./validation.ts";
