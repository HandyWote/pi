/**
 * Semantic checks on the flat command list produced by the tree-sitter
 * parser (Claude Code's checkSemantics, implemented from scratch).
 *
 * The parser answers "can we tokenize this into simple commands?". This
 * module answers "is a simple command's name itself dangerous?" — builtins
 * that evaluate their arguments as shell code (eval, exec, source, ...),
 * runtime-determined command names, and shell keywords in command position
 * (a tree-sitter mis-parse signature).
 *
 * The blacklist is deliberately restrained: only names that are dangerous
 * on their own. Plain binaries (rm, curl, ...) are not listed — they are
 * handled by the permission rules, not by name.
 */

/** Builtins that evaluate their arguments as shell code. */
const EVAL_LIKE_BUILTINS = new Set([
	"eval",
	"exec",
	"source",
	".",
	"shopt",
	"trap",
	"alias",
	"let",
	"fc",
	"enable",
	"mapfile",
	"readarray",
	"hash",
	"bind",
	"complete",
	"compgen",
	"coproc",
	"builtin",
	"command",
]);

/** Shell reserved words that can never be legitimate command names. */
const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"for",
	"select",
	"in",
	"do",
	"done",
	"case",
	"esac",
	"function",
]);

const ASSIGN_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const REDIRECT_OP_RE = /^(?:[0-9]+)?(?:<<-|<<<|<<|>>|>\||>&-|>&|&>>|&>|<>|<&-|<&|<|>)/;
/** A redirect operator with no fused destination (`> out`, not `>out`). */
const REDIRECT_OP_ONLY_RE = /^(?:[0-9]+)?(?:<<-|<<<|<<|>>|>\||>&-|>&|&>>|&>|<>|<&-|<&|<|>)$/;

export type SemanticsResult = { ok: true } | { ok: false; reason: string };

/**
 * Check a list of simple-command texts (as produced by
 * `parseBashCommand`'s `simple` result) for dangerous command names.
 * Returns `ok: false` with a reason when any command must be confirmed
 * interactively.
 */
export function checkSemantics(commands: string[]): SemanticsResult {
	for (const command of commands) {
		const reason = checkCommandText(command);
		if (reason !== null) {
			return { ok: false, reason };
		}
	}
	return { ok: true };
}

/**
 * Check a single command text. Returns a rejection reason or null.
 * The command name is the first token after leading env assignments and
 * redirects; benign wrapper commands (time, nohup, timeout, nice, env) are
 * stripped so the wrapped command is checked too.
 */
function checkCommandText(text: string): string | null {
	const tokens = tokenize(text);
	let i = skipLeadingNoise(tokens);
	if (i >= tokens.length) return null;

	for (let depth = 0; ; depth++) {
		if (depth > MAX_WRAPPER_DEPTH) return null;
		const name = unquoteWord(tokens[i]!);
		if (name === "") return null;

		if (EVAL_LIKE_BUILTINS.has(name)) {
			// `command -v` / `command -V` only print a path — no execution.
			if (name === "command" && (tokens[i + 1] === "-v" || tokens[i + 1] === "-V")) {
				return null;
			}
			return `'${name}' evaluates shell code — cannot be statically analyzed`;
		}
		if (SHELL_KEYWORDS.has(name)) {
			return `Shell keyword '${name}' as command name — parser mis-parse`;
		}
		if (/^[$`]/.test(name)) {
			return `Command name '${name}' is runtime-determined — cannot be statically analyzed`;
		}

		const next = stripWrapper(tokens, i, name);
		if (next === WRAPPER_UNANALYZABLE) {
			return `'${name}' with unrecognized flags — cannot locate the wrapped command`;
		}
		if (next === null || next === i) return null;
		i = next;
	}
}

const MAX_WRAPPER_DEPTH = 5;
/** Sentinel: a wrapper flag we don't understand — fail closed. */
const WRAPPER_UNANALYZABLE = Symbol("wrapper-unanalyzable");

/**
 * Skip the wrapper command's own arguments and return the index of the
 * wrapped command, null when `name` is not a wrapper (or has no wrapped
 * command), or WRAPPER_UNANALYZABLE when the wrapper's flags make the
 * wrapped command position unknowable.
 */
function stripWrapper(tokens: string[], i: number, name: string): number | null | typeof WRAPPER_UNANALYZABLE {
	if (name === "time" || name === "nohup") {
		return i + 1 < tokens.length ? i + 1 : null;
	}
	if (name === "timeout") return stripTimeout(tokens, i);
	if (name === "nice") return stripNice(tokens, i);
	if (name === "env") return stripEnv(tokens, i);
	return null;
}

function stripTimeout(tokens: string[], i: number): number | null | typeof WRAPPER_UNANALYZABLE {
	let j = i + 1;
	for (;;) {
		const tok = unquoteWord(tokens[j] ?? "");
		if (tok === "") return null;
		if (tok === "--foreground" || tok === "--preserve-status" || tok === "--verbose" || tok === "-v") {
			j++;
			continue;
		}
		if (/^--(?:kill-after|signal)=.+$/.test(tok)) {
			j++;
			continue;
		}
		if ((tok === "--kill-after" || tok === "--signal") && tokens[j + 1] !== undefined) {
			j += 2;
			continue;
		}
		if (/^-[ks][A-Za-z0-9_.+-]+$/.test(tok) || ((tok === "-k" || tok === "-s") && tokens[j + 1] !== undefined)) {
			j += tok === "-k" || tok === "-s" ? 2 : 1;
			continue;
		}
		if (tok.startsWith("-")) return WRAPPER_UNANALYZABLE;
		if (!/^\d+(?:\.\d+)?[smhd]?$/.test(tok)) {
			return WRAPPER_UNANALYZABLE;
		}
		return j + 1 < tokens.length ? j + 1 : null;
	}
}

function stripNice(tokens: string[], i: number): number | null | typeof WRAPPER_UNANALYZABLE {
	const next = unquoteWord(tokens[i + 1] ?? "");
	if (next === "-n" && tokens[i + 2] !== undefined) {
		return i + 3 < tokens.length ? i + 3 : null;
	}
	if (/^-\d+$/.test(next)) {
		return i + 2 < tokens.length ? i + 2 : null;
	}
	if (/[$`(]/.test(next)) return WRAPPER_UNANALYZABLE;
	return i + 1 < tokens.length ? i + 1 : null;
}

function stripEnv(tokens: string[], i: number): number | null | typeof WRAPPER_UNANALYZABLE {
	let j = i + 1;
	for (;;) {
		const tok = unquoteWord(tokens[j] ?? "");
		if (tok === "") return null;
		if (ASSIGN_TOKEN_RE.test(tokens[j]!)) {
			j++;
			continue;
		}
		if (tok === "-i" || tok === "-0" || tok === "-v") {
			j++;
			continue;
		}
		if (tok === "-u" && tokens[j + 1] !== undefined) {
			j += 2;
			continue;
		}
		if (tok.startsWith("-")) return WRAPPER_UNANALYZABLE;
		return j < tokens.length ? j : null;
	}
}

/**
 * Skip leading env assignments (`FOO=bar`) and redirects (`2>&1`, `> out`)
 * that precede the actual command name, returning the first token index.
 */
function skipLeadingNoise(tokens: string[]): number {
	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (ASSIGN_TOKEN_RE.test(tok)) {
			i++;
			continue;
		}
		if (REDIRECT_OP_RE.test(tok)) {
			i += REDIRECT_OP_ONLY_RE.test(tok) ? 2 : 1;
			continue;
		}
		break;
	}
	return i;
}

/**
 * Split a command text into whitespace-delimited tokens, keeping quoted
 * spans (`'a b'`, `"a b"`), backslash escapes, and balanced `$(...)`
 * groups intact so values with spaces do not shift the command-name
 * position.
 */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i]!)) i++;
		if (i >= text.length) break;
		const start = i;
		while (i < text.length && !/\s/.test(text[i]!)) {
			const c = text[i]!;
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "'" || c === '"') {
				i = skipQuoted(text, i, c);
				continue;
			}
			if (c === "$" && text[i + 1] === "(") {
				i = skipBalanced(text, i + 1);
				continue;
			}
			i++;
		}
		tokens.push(text.slice(start, i));
	}
	return tokens;
}

/** Advance past a `'...'` / `"..."` span (text[i] is the opening quote). */
function skipQuoted(text: string, i: number, quote: string): number {
	i++;
	while (i < text.length) {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === quote) return i + 1;
		i++;
	}
	return i;
}

/** Advance past balanced parens (text[i] is the opening paren). */
function skipBalanced(text: string, i: number): number {
	let depth = 0;
	for (; i < text.length; i++) {
		const c = text[i]!;
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			i = skipQuoted(text, i, c) - 1;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return i;
}

/** Strip one layer of quotes and backslash escapes from a word. */
function unquoteWord(word: string): string {
	const unquoted = word.replace(/\\(.)/g, "$1");
	if (
		unquoted.length >= 2 &&
		((unquoted[0] === "'" && unquoted.at(-1) === "'") || (unquoted[0] === '"' && unquoted.at(-1) === '"'))
	) {
		return unquoted.slice(1, -1);
	}
	return unquoted;
}
