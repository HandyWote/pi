/**
 * Auth reference adapter for the profile compiler.
 *
 * Associates profile authentication with mechanisms the official runtime
 * already supports: the official auth.json store, environment variables
 * (`$VAR` / `${VAR}`), and key-producing commands (`!command`). Plaintext API
 * keys must never enter profile-state.json or compiled models.json; this
 * module is the single place that classifies, serializes, and audits key
 * references.
 *
 * Pure module: no store, discovery, or UI concerns. No child processes are
 * spawned here; command references are classified but only resolved by the
 * runtime.
 */

/** Compiled models.json provider entry, restricted to auth-relevant fields. */
export interface AuthProviderView {
	apiKey?: string;
}

/** Compiled models.json document, restricted to auth-relevant fields. */
export interface AuthModelsJsonView {
	providers: Record<string, AuthProviderView>;
}

/**
 * A key reference. `authJson` means the credential lives in the official
 * auth.json store keyed by provider ID, so the compiled provider entry must
 * NOT carry an `apiKey` (it would shadow the auth.json lookup).
 */
export type AuthReference =
	| { kind: "authJson"; providerId: string }
	| { kind: "env"; variable: string }
	| { kind: "command"; command: string };

/** A legacy `profiles.json` `Profile.apiKey` value that is a raw plaintext secret. */
export interface PlaintextAuthValue {
	kind: "plaintext";
	value: string;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function authJsonReference(providerId: string): AuthReference {
	return { kind: "authJson", providerId };
}

export function envReference(variable: string): AuthReference {
	if (!ENV_NAME_PATTERN.test(variable)) {
		throw new Error(`Invalid environment variable name for auth reference: "${variable}"`);
	}
	return { kind: "env", variable };
}

export function commandReference(command: string): AuthReference {
	if (command.length === 0) {
		throw new Error("Auth command reference must not be empty");
	}
	return { kind: "command", command };
}

/**
 * Serialize a reference into the official models.json `apiKey` string grammar.
 *
 * `authJson` references serialize to `undefined`: the official runtime
 * resolves auth.json credentials by provider ID, and an `apiKey` on the
 * provider entry would take precedence over it.
 */
export function serializeAuthReference(reference: AuthReference): string | undefined {
	switch (reference.kind) {
		case "authJson":
			return undefined;
		case "env":
			return `$${reference.variable}`;
		case "command":
			return `!${reference.command}`;
	}
}

/** Parse an existing models.json `apiKey` string into a reference, or flag it as plaintext. */
export function parseAuthReference(value: string): AuthReference | PlaintextAuthValue {
	if (value.startsWith("!")) {
		return commandReference(value.slice(1));
	}
	if (value.startsWith("${") && value.endsWith("}")) {
		return envReference(value.slice(2, -1));
	}
	if (value.startsWith("$")) {
		return envReference(value.slice(1));
	}
	return { kind: "plaintext", value };
}

/**
 * Resolve a reference to the literal key string where that can be done purely.
 * - `env`: looked up in the provided env map (undefined when unset).
 * - `authJson`: always undefined; the official runtime owns this lookup.
 * - `command`: always undefined; execution is the runtime's job.
 */
export function resolveAuthReference(
	reference: AuthReference,
	env?: Record<string, string | undefined>,
): string | undefined {
	switch (reference.kind) {
		case "authJson":
			return undefined;
		case "env":
			return env?.[reference.variable];
		case "command":
			return undefined;
	}
}

/**
 * Build the models.json `apiKey` value for a profile.
 *
 * Priority: auth.json association (`authProviderId`) wins and yields no
 * `apiKey`; otherwise the profile's explicit reference is serialized. When
 * neither is present the entry carries no `apiKey`.
 */
export function modelsJsonApiKey(profile: {
	authProviderId?: string;
	authReference?: AuthReference;
}): string | undefined {
	if (profile.authProviderId) return undefined;
	if (profile.authReference) return serializeAuthReference(profile.authReference);
	return undefined;
}

/** True when a profile's authentication resolves through the official auth.json store. */
export function usesAuthJson(profile: { authProviderId?: string }): boolean {
	return profile.authProviderId !== undefined;
}

export interface AuthDiagnostic {
	severity: "warning" | "error";
	message: string;
	profileId?: string;
	providerId?: string;
}

/**
 * Check that a profile's auth.json association matches the compiled provider
 * ID. auth.json credentials are keyed by provider ID, so a mismatched
 * `authProviderId` means the runtime will not find the credential.
 */
export function checkAuthAssociation(profile: { id: string; authProviderId?: string }): AuthDiagnostic[] {
	if (profile.authProviderId === undefined) return [];
	if (profile.authProviderId === profile.id) return [];
	return [
		{
			severity: "error",
			profileId: profile.id,
			providerId: profile.id,
			message: `authProviderId "${profile.authProviderId}" does not match compiled provider id "${profile.id}"; the auth.json credential will not resolve`,
		},
	];
}

/** Scan a compiled document for plaintext-looking `apiKey` values (defense in depth). */
export function findPlaintextKeys(doc: AuthModelsJsonView): AuthDiagnostic[] {
	const diagnostics: AuthDiagnostic[] = [];
	for (const [providerId, provider] of Object.entries(doc.providers)) {
		if (provider.apiKey === undefined) continue;
		if (parseAuthReference(provider.apiKey).kind === "plaintext") {
			diagnostics.push({
				severity: "warning",
				providerId,
				message: `provider "${providerId}" carries a plaintext apiKey; move it into auth.json, an environment variable, or a key command`,
			});
		}
	}
	return diagnostics;
}

/**
 * Map a legacy `profiles.json` `Profile.apiKey` value to a reference.
 *
 * - Values already in reference grammar (`$VAR`, `${VAR}`, `!cmd`) pass through.
 * - Plaintext values with an `authProviderId` become an auth.json reference;
 *   the migrator must move the secret into auth.json.
 * - Plaintext values without an association are returned as-is so the caller
 *   can decide; they must not be persisted.
 */
export function legacyApiKeyToReference(apiKey: string, authProviderId?: string): AuthReference | PlaintextAuthValue {
	const parsed = parseAuthReference(apiKey);
	if (parsed.kind !== "plaintext") return parsed;
	if (authProviderId) return authJsonReference(authProviderId);
	return parsed;
}
