import { homedir } from "node:os";
import { isAbsolute, resolve as nodeResolvePath } from "node:path";

export interface PathInputOptions {
	trim?: boolean;
	expandTilde?: boolean;
	homeDir?: string;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	const normalized = options.trim ? input.trim() : input;

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return nodeResolvePath(home, normalized.slice(2));
		}
	}

	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalized);
}
