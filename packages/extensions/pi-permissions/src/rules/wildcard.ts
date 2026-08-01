/**
 * Wildcard matching for rule content, aligned with Claude Code semantics:
 *
 * - `*` matches any sequence of characters (including empty and newlines)
 * - `\*` matches a literal asterisk
 * - `\\` matches a literal backslash
 * - a trailing `:*` is legacy prefix syntax handled by the caller
 *
 * Matching is anchored (the whole string must match).
 *
 * Implemented as a linear-time two-pointer glob match instead of a dynamic
 * RegExp: no regex compilation per check and no backtracking (ReDoS-safe).
 */

// Single-character sentinels for escaped literals. SOH/STX cannot appear in
// command text in practice; norm() maps them back for comparison.
const STAR_LITERAL = "\x01";
const BACKSLASH_LITERAL = "\x02";

function norm(ch: string): string {
	if (ch === STAR_LITERAL) return "*";
	if (ch === BACKSLASH_LITERAL) return "\\";
	return ch;
}

/**
 * True when the pattern contains an unescaped `*` that is not part of a
 * legacy trailing `:*` prefix.
 */
export function hasWildcards(pattern: string): boolean {
	if (pattern.endsWith(":*")) return false;
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] !== "*") continue;
		// Count backslashes before this asterisk; an even count (including
		// zero) means the asterisk is unescaped.
		let backslashes = 0;
		for (let j = i - 1; j >= 0 && pattern[j] === "\\"; j--) backslashes++;
		if (backslashes % 2 === 0) return true;
	}
	return false;
}

/**
 * Translate escape sequences to sentinel characters so the glob matcher
 * treats them as literals.
 */
function translateEscapes(pattern: string): string {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\" && i + 1 < pattern.length) {
			const next = pattern[i + 1];
			if (next === "*") {
				out += STAR_LITERAL;
				i += 1;
				continue;
			}
			if (next === "\\") {
				out += BACKSLASH_LITERAL;
				i += 1;
				continue;
			}
		}
		out += ch;
	}
	return out;
}

/**
 * Classic greedy glob match: `*` in the pattern matches any run of
 * characters. Linear time — each input character is consumed at most twice.
 */
function globMatch(pattern: string, value: string): boolean {
	let p = 0;
	let v = 0;
	let starP = -1;
	let starV = 0;
	while (v < value.length) {
		if (p < pattern.length && norm(pattern[p]) === value[v]) {
			p++;
			v++;
		} else if (p < pattern.length && pattern[p] === "*") {
			starP = p;
			starV = v;
			p++;
		} else if (starP !== -1) {
			p = starP + 1;
			v = ++starV;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}

/** Exact comparison honoring escape sequences (e.g. `rm \*` matches `rm *`). */
export function normalizedEquals(pattern: string, value: string): boolean {
	const translated = translateEscapes(pattern);
	if (translated.length !== value.length) return false;
	for (let i = 0; i < translated.length; i++) {
		if (norm(translated[i]) !== value[i]) return false;
	}
	return true;
}

export function matchWildcardPattern(pattern: string, value: string): boolean {
	const processed = translateEscapes(pattern.trim());

	// When a pattern ends with ' *' and that is its only unescaped wildcard,
	// make the trailing space-and-args optional so `git *` matches bare
	// `git` too — aligning wildcard semantics with legacy prefix rules.
	const unescapedStars = (processed.match(/\*/g) ?? []).length;
	if (processed.endsWith(" *") && unescapedStars === 1) {
		const prefix = processed.slice(0, -2);
		return globMatch(prefix, value) || value.startsWith(`${prefix} `);
	}

	return globMatch(processed, value);
}
