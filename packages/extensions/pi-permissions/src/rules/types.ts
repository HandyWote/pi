/**
 * Permission rule types.
 *
 * A rule is `Tool(content)` — e.g. `Bash(git:*)`, `Edit(.git/*)`.
 * The tool name matches any tool case-insensitively (pi tool names are
 * lowercase: `bash`, `edit`, `write`, `read`, `grep`, `find`, `ls`; custom
 * and MCP tools match by their exact name). The optional content is matched
 * by each tool's rule matcher (commands for bash, path globs for edit/write).
 */

export type PermissionBehavior = "allow" | "deny" | "ask";

export type RuleSource = "user" | "session" | "project" | "cliArg";

export interface PermissionRuleValue {
	/** Tool name, case-insensitive when matching. */
	toolName: string;
	/** Optional content (command pattern, path glob, ...). */
	ruleContent?: string;
}

export interface PermissionRule {
	source: RuleSource;
	behavior: PermissionBehavior;
	value: PermissionRuleValue;
}

/** Rules grouped by behavior, per source. */
export interface RuleCollection {
	/** User-level rules (from ~/.pi/permissions.json + CLI flags). */
	user: { allow: PermissionRuleValue[]; deny: PermissionRuleValue[]; ask: PermissionRuleValue[] };
	/** Session-scoped rules (memory only, "allow this session"). */
	session: { allow: PermissionRuleValue[] };
	/** Project rules (.pi/permissions.json): allow only, shadowed by user rules. */
	project: { allow: PermissionRuleValue[] };
}

export function emptyRuleCollection(): RuleCollection {
	return {
		user: { allow: [], deny: [], ask: [] },
		session: { allow: [] },
		project: { allow: [] },
	};
}

/** Outcome of matching rules against a tool call. */
export interface ToolRuleVerdict {
	deny?: PermissionRule;
	ask?: PermissionRule;
	allow?: PermissionRule;
}
