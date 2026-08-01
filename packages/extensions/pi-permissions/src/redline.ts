import * as os from "node:os";
import * as path from "node:path";

export type RedlineOperation = "read" | "write";

export interface RedlineCheckInput {
	toolName: string;
	paths: string[];
	cwd: string;
	operation: RedlineOperation;
}

export interface RedlineResult {
	hit: boolean;
	matchedPath?: string;
	reason?: string;
}

/**
 * Shell config files that are redlined when written, but only when located
 * directly in the user's home directory (a project-local .bashrc is fine).
 */
const SHELL_CONFIG_FILES = [
	".bashrc",
	".bash_profile",
	".profile",
	".zshrc",
	".zprofile",
	".zshenv",
	".config/fish/config.fish",
] as const;

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** True when p is dir itself or anything below it. */
function isWithin(dir: string, p: string): boolean {
	return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** True when any path segment of p equals the given name. */
function hasSegment(p: string, segment: string): boolean {
	return p.split(path.sep).some((part) => part === segment);
}

/**
 * Sensitive-path red line: any auto-approval path (chat auto-allow,
 * acceptEdits, auto classifier) must still force a prompt for these paths.
 * Headless mode rejects them. Modeled on Claude Code's
 * checkPathSafetyForAutoEdit semantics.
 */
export function checkRedline(input: RedlineCheckInput): RedlineResult {
	const homedir = os.homedir();
	const sshDir = path.join(homedir, ".ssh");
	const shellConfigs = new Set(SHELL_CONFIG_FILES.map((name) => path.join(homedir, name)));

	for (const raw of input.paths) {
		if (raw === "") continue;
		const p = path.resolve(input.cwd, expandHome(raw));

		// ~/.ssh is redlined for both reads (private keys leak) and writes.
		if (isWithin(sshDir, p)) {
			return {
				hit: true,
				matchedPath: p,
				reason: input.operation === "read" ? "reading inside ~/.ssh directory" : "writing inside ~/.ssh directory",
			};
		}

		if (input.operation !== "write") continue;

		if (hasSegment(p, ".git")) {
			return { hit: true, matchedPath: p, reason: "writing inside .git directory" };
		}
		if (hasSegment(p, ".pi")) {
			return { hit: true, matchedPath: p, reason: "writing inside .pi directory" };
		}
		if (hasSegment(p, ".claude")) {
			return { hit: true, matchedPath: p, reason: "writing inside .claude directory" };
		}
		if (shellConfigs.has(p)) {
			return { hit: true, matchedPath: p, reason: "writing shell config file" };
		}
	}

	return { hit: false };
}
