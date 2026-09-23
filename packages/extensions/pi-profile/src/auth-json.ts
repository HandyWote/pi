import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./profiles-store.ts";

type AuthFile = Record<string, unknown>;

function getAuthJsonPath(): string {
	return join(getAgentDir(), "auth.json");
}
function readAuthFile(path: string): AuthFile {
	if (!existsSync(path)) return {};
	const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("auth.json must contain an object");
	return value as AuthFile;
}
export function hasStoredApiKey(providerId: string, authPath = getAuthJsonPath()): boolean {
	try {
		const credential = readAuthFile(authPath)[providerId];
		return (
			typeof credential === "object" &&
			credential !== null &&
			"type" in credential &&
			credential.type === "api_key" &&
			"key" in credential &&
			typeof credential.key === "string" &&
			credential.key.trim().length > 0
		);
	} catch {
		return false;
	}
}
export function saveApiKey(providerId: string, key: string, authPath = getAuthJsonPath()): void {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("API key must not be empty");
	const dir = dirname(authPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const auth = readAuthFile(authPath);
	auth[providerId] = { type: "api_key", key: trimmed };
	writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(authPath, 0o600);
}
export function readApiKey(providerId: string, authPath = getAuthJsonPath()): string | undefined {
	try {
		const credential = readAuthFile(authPath)[providerId];
		if (
			typeof credential !== "object" ||
			credential === null ||
			!("type" in credential) ||
			credential.type !== "api_key" ||
			!("key" in credential) ||
			typeof credential.key !== "string"
		)
			return undefined;
		return credential.key;
	} catch {
		return undefined;
	}
}
