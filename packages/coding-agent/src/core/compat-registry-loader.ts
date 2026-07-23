import { readFileSync } from "node:fs";
import {
	BUILTIN_COMPAT_REGISTRY,
	type CompatRegistryValidationIssue,
	type CompiledModelCompatRegistry,
	validateCompatRegistry,
} from "@handy_wote/pi-ai";
import { resolvePath } from "../utils/paths.ts";

export interface CompatRegistrySource {
	type: "file";
	path: string;
	/** Directory containing the settings file that declared this source. */
	baseDir?: string;
}

export type CompatRegistryDiagnosticCode =
	| "invalid-source"
	| "file-not-found"
	| "read-error"
	| "invalid-json"
	| "invalid-registry";

export interface CompatRegistryDiagnostic {
	type: "warning";
	code: CompatRegistryDiagnosticCode;
	message: string;
	sourceIndex: number;
	path?: string;
	issues?: CompatRegistryValidationIssue[];
}

export interface LoadCompatRegistriesOptions {
	/** Base directory for descriptors without source provenance. */
	defaultBaseDir?: string;
	/** Testable override for leading `~` expansion. */
	homeDir?: string;
}

export interface LoadCompatRegistriesResult {
	registries: CompiledModelCompatRegistry[];
	diagnostics: CompatRegistryDiagnostic[];
}

function validateSource(value: unknown): value is CompatRegistrySource {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const source = value as Record<string, unknown>;
	if (Object.keys(source).some((key) => key !== "type" && key !== "path" && key !== "baseDir")) return false;
	return (
		source.type === "file" &&
		typeof source.path === "string" &&
		source.path.length > 0 &&
		(source.baseDir === undefined || (typeof source.baseDir === "string" && source.baseDir.length > 0))
	);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

/**
 * Loads external registry files without flattening source precedence.
 * Invalid sources are reported and skipped independently.
 */
export function loadCompatRegistries(
	sources: readonly unknown[] = [],
	options: LoadCompatRegistriesOptions = {},
): LoadCompatRegistriesResult {
	const registries: CompiledModelCompatRegistry[] = [BUILTIN_COMPAT_REGISTRY];
	const diagnostics: CompatRegistryDiagnostic[] = [];

	for (const [sourceIndex, candidate] of sources.entries()) {
		if (!validateSource(candidate)) {
			diagnostics.push({
				type: "warning",
				code: "invalid-source",
				message: "Invalid compat registry source descriptor; expected a file path",
				sourceIndex,
			});
			continue;
		}

		const path = resolvePath(candidate.path, candidate.baseDir ?? options.defaultBaseDir, {
			homeDir: options.homeDir,
		});
		let raw: string;
		try {
			raw = readFileSync(path, "utf-8");
		} catch (error) {
			const missing = errorCode(error) === "ENOENT";
			diagnostics.push({
				type: "warning",
				code: missing ? "file-not-found" : "read-error",
				message: missing ? "Compat registry file does not exist" : "Failed to read compat registry file",
				sourceIndex,
				path,
			});
			continue;
		}

		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			diagnostics.push({
				type: "warning",
				code: "invalid-json",
				message: "Compat registry file contains invalid JSON",
				sourceIndex,
				path,
			});
			continue;
		}

		const result = validateCompatRegistry(value);
		if (!result.success) {
			diagnostics.push({
				type: "warning",
				code: "invalid-registry",
				message: "Compat registry file does not match the supported schema",
				sourceIndex,
				path,
				issues: result.issues,
			});
			continue;
		}
		registries.push(result.registry);
	}

	return { registries, diagnostics };
}
