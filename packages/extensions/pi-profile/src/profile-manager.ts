/**
 * Profile manager: glue between the store, the compiler, and models.json.
 *
 * Persistence flow (per the profile plugin decisions): save to
 * profile-state.json first, then compile ALL profiles' enabled/routable
 * models and atomically merge them into models.json (tmp+rename). models.json
 * is a pure compilation product; it is never read back as profile state.
 */

import { join } from "node:path";
import { atomicWriteFileSync, readTextFileIfExists } from "./atomic-write.ts";
import {
	COMPILABLE_APIS,
	type CompileDiagnostic,
	type CompilerProfileInput,
	compileProfiles,
	mergeIntoModelsJson,
	serializeModelsJson,
} from "./compiler.ts";
import { getAgentDir, ProfilesStore } from "./profiles-store.ts";
import type { Profile } from "./profiles-types.ts";

/** Absolute path of the compiled official models.json. */
export function getModelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Map a stored Profile onto the compiler's profile input. */
export function toCompilerProfileInput(profile: Profile): CompilerProfileInput {
	// Only compilable APIs can be emitted into models.json; other discovered
	// route types are filtered out here.
	const compilableRoutes = Object.fromEntries(
		Object.entries(profile.apiRoutes ?? {}).filter(([api]) => (COMPILABLE_APIS as readonly string[]).includes(api)),
	) as CompilerProfileInput["models"][number]["apiRoutes"];

	return {
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		headers: profile.headers,
		// Preserve the stored auth.json association verbatim. auth.json
		// credentials are keyed by provider ID, so a mismatch with the compiled
		// provider ID is a real configuration error; the compiler reports it via
		// checkAuthAssociation instead of silently rewriting the reference.
		authProviderId: profile.authReference?.authProviderId,
		models: profile.models.map((model) => ({
			id: model.id,
			name: model.name,
			enabled: model.enabled,
			available: model.available,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			supportsReasoning: model.supportsReasoning,
			supportsVision: model.supportsVision,
			thinkingLevelMap: model.thinkingLevelMap,
			cost: model.cost,
			overrides: model.overrides
				? {
						name: model.overrides.name,
						contextWindow: model.overrides.contextWindow,
						maxTokens: model.overrides.maxTokens,
						supportsReasoning: model.overrides.supportsReasoning,
						supportsVision: model.overrides.supportsVision,
						thinkingLevelMap: model.overrides.thinkingLevelMap,
						cost: model.overrides.cost,
						apis: model.overrides.apis,
					}
				: undefined,
			// Profile-level routes apply to every model; per-model routes do not
			// exist in the UserModel schema (only per-model API preference does).
			apiRoutes: compilableRoutes,
			apiPreference: model.apiPreference,
			familyApiPreferences: profile.familyApiPreferences,
			gatewayPreferredApi: model.gatewayPreferredApi,
			availableApis: model.availableApis?.filter((api): api is (typeof COMPILABLE_APIS)[number] =>
				(COMPILABLE_APIS as readonly string[]).includes(api),
			),
			profileApiPreference: profile.apiPreference,
			profileProtocol: profile.protocol,
		})),
	};
}

/**
 * Strip a UTF-8 BOM. The official models.json loader accepts BOM-prefixed
 * files, so the merge path must too.
 */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Strip `//` and block comments while preserving string contents. This
 * mirrors the official loader's `stripJsonComments` behavior; trailing commas
 * are not accepted there either.
 */
function stripJsonComments(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}
		if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			if (i < text.length) result += text[i];
			continue;
		}
		if (char === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i += 1;
			continue;
		}
		result += char;
	}
	return result;
}

/** Parse an existing models.json without throwing; report parse failures. */
function parseExistingModelsJson(raw: string | undefined): { doc: unknown; error?: string } {
	if (raw === undefined) return { doc: undefined };
	try {
		return { doc: JSON.parse(stripJsonComments(stripBom(raw))) as unknown };
	} catch (error) {
		return { doc: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Compile all stored profiles and atomically merge the result into
 * models.json (tmp+rename). Returns the compiler diagnostics.
 *
 * Ownership: provider IDs written by the previous compile are recorded in
 * profile-state.json. They are removed from models.json before the current
 * compile is merged, so stale providers disappear while user-owned providers
 * are never touched. A models.json that cannot be parsed is left byte-for-byte
 * unchanged and reported as an error diagnostic instead of being overwritten.
 */
export function compileAndWriteModelsJson(store: ProfilesStore, modelsJsonPath?: string): CompileDiagnostic[] {
	const profiles = store.list();
	const inputs = profiles.map((profile) => toCompilerProfileInput(profile));
	const { doc, diagnostics } = compileProfiles(inputs);

	const targetPath = modelsJsonPath ?? getModelsJsonPath();
	const existingRaw = readTextFileIfExists(targetPath);
	const parsed = parseExistingModelsJson(existingRaw);
	if (parsed.error !== undefined) {
		diagnostics.push({
			severity: "error",
			message: `models.json could not be parsed (${parsed.error}); left unchanged so existing providers are not lost`,
		});
		return diagnostics;
	}

	const previousManaged = store.getManagedProviderIds();
	const merged = mergeIntoModelsJson(parsed.doc, doc, previousManaged);
	// Atomic tmp+rename: the official runtime may read models.json at any time.
	atomicWriteFileSync(targetPath, serializeModelsJson(merged));
	const currentManaged = Object.keys(doc.providers);
	if (
		previousManaged.length !== currentManaged.length ||
		previousManaged.some((id, index) => id !== currentManaged[index])
	) {
		store.setManagedProviderIds(currentManaged);
	}
	return diagnostics;
}

export { ProfilesStore };
