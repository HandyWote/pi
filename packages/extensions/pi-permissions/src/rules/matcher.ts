/**
 * Rule matching and shadowing.
 *
 * Rule shapes for ruleContent:
 * - `foo`            exact match
 * - `foo:*`          legacy prefix (matches `foo` and `foo ...`)
 * - `foo *` / `foo*` wildcard (see wildcard.ts)
 *
 * Shadowing (project rules are always below user rules):
 * - user deny    > project allow
 * - user ask     > project allow
 * - user allow   == session allow (both are user-side)
 * - project allow only applies when no user rule matches
 */

import type { PermissionRule, PermissionRuleValue, RuleCollection, ToolRuleVerdict } from "./types.ts";
import { hasWildcards, matchWildcardPattern, normalizedEquals } from "./wildcard.ts";

export function toolNameMatches(ruleToolName: string, toolName: string): boolean {
	return ruleToolName.toLowerCase() === toolName.toLowerCase();
}

/** True when a rule has no content and its tool name matches the tool. */
export function ruleMatchesTool(rule: PermissionRuleValue, toolName: string): boolean {
	return rule.ruleContent === undefined && toolNameMatches(rule.toolName, toolName);
}

/**
 * Match rule content against a value (a bash subcommand, a path, ...).
 * Returns true for a whole-tool rule (no content): a whole-tool rule applies
 * to every invocation of that tool.
 */
export function ruleContentMatches(rule: PermissionRuleValue, toolName: string, value: string): boolean {
	if (!toolNameMatches(rule.toolName, toolName)) return false;
	if (rule.ruleContent === undefined) return true;
	return matchRuleContent(rule.ruleContent, value);
}

export function matchRuleContent(pattern: string, value: string): boolean {
	// Legacy prefix syntax: `git:*` matches `git` and anything starting with
	// `git `.
	if (pattern.endsWith(":*")) {
		const prefix = pattern.slice(0, -2);
		return value === prefix || value.startsWith(`${prefix} `);
	}
	if (hasWildcards(pattern)) {
		return matchWildcardPattern(pattern, value);
	}
	return normalizedEquals(pattern, value);
}

function firstMatching(
	rules: readonly PermissionRuleValue[],
	toolName: string,
	value?: string,
): PermissionRuleValue | undefined {
	return rules.find((r) =>
		value === undefined ? ruleMatchesTool(r, toolName) : ruleContentMatches(r, toolName, value),
	);
}

/**
 * Whole-tool verdict with shadowing applied.
 *
 * Precedence: user deny > user ask > session allow > user allow > project allow.
 */
export function matchToolRules(collection: RuleCollection, toolName: string): ToolRuleVerdict {
	const toRule = (
		value: PermissionRuleValue,
		source: PermissionRule["source"],
		behavior: PermissionRule["behavior"],
	): PermissionRule => ({
		source,
		behavior,
		value,
	});

	const userDeny = firstMatching(collection.user.deny, toolName);
	if (userDeny) return { deny: toRule(userDeny, "user", "deny") };

	const userAsk = firstMatching(collection.user.ask, toolName);
	if (userAsk) return { ask: toRule(userAsk, "user", "ask") };

	const sessionAllow = firstMatching(collection.session.allow, toolName);
	if (sessionAllow) return { allow: toRule(sessionAllow, "session", "allow") };

	const userAllow = firstMatching(collection.user.allow, toolName);
	if (userAllow) return { allow: toRule(userAllow, "user", "allow") };

	const projectAllow = firstMatching(collection.project.allow, toolName);
	if (projectAllow) return { allow: toRule(projectAllow, "project", "allow") };

	return {};
}

/**
 * Content-level verdict (bash subcommands, edit paths, ...) with shadowing.
 * `value` is the content being matched (e.g. a subcommand string).
 */
export function matchContentRules(collection: RuleCollection, toolName: string, value: string): ToolRuleVerdict {
	const toRule = (
		rule: PermissionRuleValue,
		source: PermissionRule["source"],
		behavior: PermissionRule["behavior"],
	): PermissionRule => ({
		source,
		behavior,
		value: rule,
	});

	const userDeny = firstMatching(collection.user.deny, toolName, value);
	if (userDeny) return { deny: toRule(userDeny, "user", "deny") };

	const userAsk = firstMatching(collection.user.ask, toolName, value);
	if (userAsk) return { ask: toRule(userAsk, "user", "ask") };

	const sessionAllow = firstMatching(collection.session.allow, toolName, value);
	if (sessionAllow) return { allow: toRule(sessionAllow, "session", "allow") };

	const userAllow = firstMatching(collection.user.allow, toolName, value);
	if (userAllow) return { allow: toRule(userAllow, "user", "allow") };

	const projectAllow = firstMatching(collection.project.allow, toolName, value);
	if (projectAllow) return { allow: toRule(projectAllow, "project", "allow") };

	return {};
}
