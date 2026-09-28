/**
 * Rule string parsing: `Tool(content)`.
 *
 * - `Bash(git:*)`        → { toolName: "Bash", ruleContent: "git:*" }
 * - `Bash` / `Bash()`    → { toolName: "Bash", ruleContent: undefined }
 * - anything else        → null (invalid)
 *
 * Content may contain `)`. The last `)` that closes the rule is the one that
 * is followed by end-of-string.
 */

import type { PermissionRuleValue } from "./types.ts";

const RULE_RE = /^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/s;

export function parseRuleString(input: string): PermissionRuleValue | null {
	const trimmed = input.trim();
	const match = RULE_RE.exec(trimmed);
	if (!match) return null;
	const toolName = match[1];
	const content = match[2];
	if (content === undefined) {
		return { toolName };
	}
	// Empty parentheses: `Bash()` means the whole tool.
	return content === "" ? { toolName } : { toolName, ruleContent: content };
}

export function ruleValueToString(value: PermissionRuleValue): string {
	return value.ruleContent === undefined ? value.toolName : `${value.toolName}(${value.ruleContent})`;
}

/** Parse a list of rule strings, dropping invalid entries. */
export function parseRuleList(strings: readonly string[]): PermissionRuleValue[] {
	const out: PermissionRuleValue[] = [];
	for (const s of strings) {
		const parsed = parseRuleString(s);
		if (parsed) out.push(parsed);
	}
	return out;
}
