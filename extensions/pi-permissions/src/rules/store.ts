/**
 * Rule storage.
 *
 * - User level:    ~/.pi/permissions.json        { allow, deny, ask }
 * - Project level: .pi/permissions.json          { allow } only
 * - Session level: in-memory (cleared on session start)
 *
 * Project rules load only when the project is trusted; a shadowing policy
 * keeps project rules strictly below user rules (see matcher.ts).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRuleList } from "./rule-string.ts";
import type { PermissionBehavior, RuleCollection } from "./types.ts";

export interface PermissionsFile {
	allow?: string[];
	deny?: string[];
	ask?: string[];
}

export interface RuleStoreOptions {
	/** User rules file path. Defaults to ~/.pi/permissions.json. */
	userRulesPath?: string;
	/** Project rules file path. Defaults to <cwd>/.pi/permissions.json. */
	projectRulesPath?: string;
	/** Resolve the current working directory (project root). */
	getCwd?: () => string;
	/** Whether the project is trusted (project rules load only when true). */
	isProjectTrusted?: () => boolean;
}

export class PermissionRuleStore {
	private readonly userRulesPath: string;
	private readonly projectRulesPath: string;
	private readonly getCwd: () => string;
	private isProjectTrusted: () => boolean;

	private userRules: PermissionsFile = {};
	private projectRules: PermissionsFile = {};
	private sessionAllow: string[] = [];

	constructor(options: RuleStoreOptions = {}) {
		this.userRulesPath = options.userRulesPath ?? path.join(os.homedir(), ".pi", "permissions.json");
		this.projectRulesPath = options.projectRulesPath ?? path.join(".pi", "permissions.json");
		this.getCwd = options.getCwd ?? (() => process.cwd());
		this.isProjectTrusted = options.isProjectTrusted ?? (() => true);
	}

	/**
	 * Update the project-trust answer (the session knows it; the store is
	 * created before the session starts). Call before reload().
	 */
	setProjectTrusted(trusted: boolean): void {
		this.isProjectTrusted = () => trusted;
	}

	/** Reload user + project rules from disk. Session rules are untouched. */
	async reload(): Promise<void> {
		this.userRules = await readFile(this.userRulesPath);
		if (this.isProjectTrusted()) {
			this.projectRules = await readFile(this.resolveProjectRulesPath());
		} else {
			this.projectRules = {};
		}
	}

	/** Snapshot of the current rules for matching. */
	collection(): RuleCollection {
		return {
			// CLI flag rules sit in the user group, ahead of file rules. Both
			// are user-level, so ordering is irrelevant for matching, and CLI
			// rules are never persisted.
			user: {
				allow: parseRuleList([...this.cliAllow, ...(this.userRules.allow ?? [])]),
				deny: parseRuleList([...this.cliDeny, ...(this.userRules.deny ?? [])]),
				ask: parseRuleList(this.userRules.ask ?? []),
			},
			session: { allow: parseRuleList(this.sessionAllow) },
			project: { allow: parseRuleList(this.projectRules.allow ?? []) },
		};
	}

	/** Raw user rule strings (for /permissions display). */
	userRuleStrings(): PermissionsFile {
		return this.userRules;
	}

	/** Add a rule to the user-level file and persist. */
	async addUserRule(behavior: PermissionBehavior, ruleString: string): Promise<void> {
		const key = behavior as keyof PermissionsFile;
		const list = this.userRules[key] ?? [];
		if (!list.includes(ruleString)) list.push(ruleString);
		this.userRules[key] = list;
		await writeFile(this.userRulesPath, this.userRules);
	}

	/** Remove a rule from the user-level file and persist. */
	async removeUserRule(behavior: PermissionBehavior, ruleString: string): Promise<boolean> {
		const key = behavior as keyof PermissionsFile;
		const list = (this.userRules[key] ?? []).filter((s) => s !== ruleString);
		const removed = list.length !== (this.userRules[key] ?? []).length;
		this.userRules[key] = list;
		if (removed) await writeFile(this.userRulesPath, this.userRules);
		return removed;
	}

	/** Session-scoped "allow this session" rule (memory only). */
	addSessionAllow(ruleString: string): void {
		if (!this.sessionAllow.includes(ruleString)) this.sessionAllow.push(ruleString);
	}

	clearSessionRules(): void {
		this.sessionAllow = [];
	}

	/** CLI flag rules (memory only, e.g. --permissions-allow). Merged into the user group by collection(). */
	cliAllow: string[] = [];
	cliDeny: string[] = [];

	private resolveProjectRulesPath(): string {
		return path.isAbsolute(this.projectRulesPath)
			? this.projectRulesPath
			: path.resolve(this.getCwd(), this.projectRulesPath);
	}
}

async function readFile(filePath: string): Promise<PermissionsFile> {
	try {
		const raw = await fs.promises.readFile(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const obj = parsed as Record<string, unknown>;
		const pick = (key: string): string[] =>
			Array.isArray(obj[key]) ? (obj[key] as unknown[]).filter((s): s is string => typeof s === "string") : [];
		return { allow: pick("allow"), deny: pick("deny"), ask: pick("ask") };
	} catch (error) {
		if (isMissingFile(error)) return {};
		// Corrupt rules file: fail loudly rather than silently ignoring user
		// security configuration.
		throw new Error(`Cannot read permissions file ${filePath}: ${describeError(error)}`);
	}
}

async function writeFile(filePath: string, rules: PermissionsFile): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const content = `${JSON.stringify(rules, null, 2)}\n`;
	await fs.promises.writeFile(filePath, content, "utf-8");
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
