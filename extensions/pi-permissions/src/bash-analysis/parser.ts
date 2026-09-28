/**
 * Bash command static analysis via tree-sitter WASM.
 *
 * Semantics (aligned with Claude Code's parseForSecurity, implemented from
 * scratch): a command is classified into one of three states:
 *
 *  - `simple`: parsed cleanly into a flat list of subcommand texts
 *    (`&&` / `;` / `|` chains are split; each simple command keeps its raw
 *    source text for downstream rule matching).
 *  - `too-complex`: contains constructs that execute code we cannot
 *    statically analyze (command/process substitution, control flow,
 *    function definitions, subshell arithmetic, ...) or that tree-sitter
 *    failed to parse. Callers must force an interactive confirmation.
 *  - `parse-unavailable`: the WASM runtime/grammar could not be loaded
 *    (missing file, incompatible ABI). Callers should fall back to
 *    conservative regex matching plus confirmation.
 *
 * Never throws: load failures and parse failures are folded into
 * `too-complex` / `parse-unavailable` results.
 */

import { createRequire } from "node:module";
import type { Node } from "web-tree-sitter";
import { Language, Parser } from "web-tree-sitter";

export type BashParseResult =
	| { kind: "simple"; commands: string[] }
	| { kind: "too-complex"; reason: string }
	| { kind: "parse-unavailable"; reason: string };

/** Mirrors Claude Code's MAX_COMMAND_LENGTH gate. */
const MAX_COMMAND_LENGTH = 10000;

/**
 * Pre-checks for characters where tree-sitter and bash disagree on word
 * boundaries (Claude Code runs the same guards before trusting a parse).
 * These are known parser/bash differentials, not style preferences.
 */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNICODE_WHITESPACE_RE = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const BACKSLASH_WHITESPACE_RE = /\\[ \t\n]/;

/**
 * Resolve the grammar WASM from node_modules. Works under both node and bun
 * (createRequire is standard ESM); returns null when the package is missing
 * (e.g. a bundled dist without node_modules) so we degrade to
 * parse-unavailable instead of throwing at import time.
 */
function resolveGrammarWasm(): string | null {
	try {
		return createRequire(import.meta.url).resolve("tree-sitter-bash/tree-sitter-bash.wasm");
	} catch {
		return null;
	}
}

const GRAMMAR_WASM_PATH = resolveGrammarWasm();

/** Singleton parser load; resolves to null on any load failure. */
let parserPromise: Promise<Parser | null> | null = null;

function loadParser(): Promise<Parser | null> {
	parserPromise ??= (async () => {
		if (GRAMMAR_WASM_PATH === null) return null;
		try {
			// Parser.init() locates web-tree-sitter's own runtime WASM
			// relative to the package (node: fs read, bun: URL import).
			await Parser.init();
			const language = await Language.load(GRAMMAR_WASM_PATH);
			const parser = new Parser();
			parser.setLanguage(language);
			return parser;
		} catch {
			return null;
		}
	})();
	return parserPromise;
}

/**
 * Parse a bash command into a flat list of simple-command texts.
 *
 * `commands` entries are the raw source spans of each simple command (env
 * assignments and redirects included), split on `&&`, `||`, `;`, `|`, `|&`,
 * `&`, and newlines. Nested substitutions and control flow return
 * `too-complex`; a failed WASM load returns `parse-unavailable`.
 */
export async function parseBashCommand(command: string): Promise<BashParseResult> {
	if (command === "") {
		return { kind: "simple", commands: [] };
	}
	if (command.length > MAX_COMMAND_LENGTH) {
		return {
			kind: "too-complex",
			reason: `Command length ${command.length} exceeds the ${MAX_COMMAND_LENGTH} character analysis limit`,
		};
	}
	if (CONTROL_CHAR_RE.test(command)) {
		return { kind: "too-complex", reason: "Contains control characters" };
	}
	if (UNICODE_WHITESPACE_RE.test(command)) {
		return { kind: "too-complex", reason: "Contains Unicode whitespace" };
	}
	if (BACKSLASH_WHITESPACE_RE.test(command)) {
		return {
			kind: "too-complex",
			reason: "Contains backslash-escaped whitespace",
		};
	}

	const parser = await loadParser();
	if (parser === null) {
		return {
			kind: "parse-unavailable",
			reason: "tree-sitter WASM runtime or bash grammar could not be loaded",
		};
	}

	let root: Node | null;
	try {
		const tree = parser.parse(command);
		if (tree === null) {
			// Fail closed: a loaded parser that fails to produce a tree must
			// not be trusted (mirrors Claude Code's PARSE_ABORTED handling).
			return { kind: "too-complex", reason: "Parser aborted" };
		}
		root = tree.rootNode;
	} catch {
		// Fail closed: a loaded parser that throws must not be trusted.
		return { kind: "too-complex", reason: "Parser aborted" };
	}
	if (root.hasError) {
		return { kind: "too-complex", reason: "Parse error" };
	}

	const commands: string[] = [];
	const err = walkProgram(root, commands);
	if (err !== null) return err;
	return { kind: "simple", commands };
}

// ─────────────────────────── AST walker ───────────────────────────

/**
 * Structural wrappers: recurse into children; the wrapped commands are
 * collected. `negated_command` is `! cmd` (inverts exit code only), and
 * `subshell` runs its inner commands in a child shell — both execute the
 * inner commands, so they are extracted like any other command sequence.
 */
const STRUCTURAL_TYPES = new Set([
	"program",
	"list",
	"pipeline",
	"redirected_statement",
	"negated_command",
	"subshell",
]);

/**
 * Nodes that carry no command text of their own but may contain
 * substitutions or nested commands in their children — recurse, never
 * collect. `heredoc_redirect` is here because tree-sitter nests anything
 * after the heredoc marker (`cat <<EOF | grep x`) inside it.
 */
const CONTAINER_TYPES = new Set([
	"command_name",
	"variable_assignment",
	"variable_assignments",
	"file_redirect",
	"herestring_redirect",
	"heredoc_redirect",
	"heredoc_body",
	"concatenation",
	"string",
	"arithmetic_expansion",
	"simple_expansion",
	"expansion",
	"test_command",
	"unary_expression",
	"binary_expression",
	"negated_expression",
	"parenthesized_expression",
]);

/** Leaf nodes with no children worth inspecting. */
const LEAF_TYPES = new Set([
	"word",
	"number",
	"raw_string",
	"string_content",
	"variable_name",
	"special_variable_name",
	"file_descriptor",
	"test_operator",
	"comment",
	"heredoc_start",
	"heredoc_end",
	"heredoc_content",
	"regex",
]);

/**
 * Node types that execute code or expand in ways that make the static
 * command list untrustworthy. `command_substitution` covers both `$(...)`
 * and backticks; `compound_statement` covers `{ ...; }` groups and
 * `(( ... ))` arithmetic evaluation.
 */
const DANGEROUS_TYPES = new Set([
	"command_substitution",
	"process_substitution",
	"if_statement",
	"while_statement",
	"until_statement",
	"for_statement",
	"c_style_for_statement",
	"select_statement",
	"case_statement",
	"function_definition",
	"compound_statement",
	"ansi_c_string",
	"translated_string",
	"brace_expression",
]);

/**
 * Commands that produce a collectable command text. `declaration_command`
 * is `export`/`declare`/`typeset`/`readonly`/`local`; `unset_command` is
 * `unset`. Both are checked for the eval-like declare forms below.
 */
const COLLECT_TYPES = new Set(["command", "declaration_command", "unset_command"]);

/**
 * `declare`/`typeset`/`local` with flags that change assignment semantics
 * (`-i` integer, `-n` nameref, `-a`/`-A` array) or with a bare subscript
 * (`declare 'x[$(id)]=v'`) make bash arithmetically evaluate the value or
 * subscript — running `$(cmd)` even from a single-quoted value that
 * tree-sitter treats as an opaque raw_string leaf. Mirrors Claude Code's
 * declaration_command guards.
 */
const DECLARE_EVAL_FLAG_RE = /^-[a-zA-Z]*[niaA]/;
const DECLARE_SUBSCRIPT_RE = /^[^=]*\[/;

function walkProgram(root: Node, commands: string[]): BashParseResult | null {
	return walk(root, commands);
}

function walk(node: Node, commands: string[]): BashParseResult | null {
	const type = node.type;

	if (COLLECT_TYPES.has(type)) {
		if (type === "declaration_command" && isEvalLikeDeclaration(node.text)) {
			return {
				kind: "too-complex",
				reason: "declare/typeset/local with eval-like flag or subscript",
			};
		}
		commands.push(node.text);
		// Fall through to recursion: a command's children may hide
		// substitutions (`echo a$(id)b`, `export FOO=$(cmd)`) that must
		// reject, so collectable types recurse like containers.
	}

	if (STRUCTURAL_TYPES.has(type) || CONTAINER_TYPES.has(type) || COLLECT_TYPES.has(type)) {
		for (const child of node.namedChildren) {
			const err = walk(child, commands);
			if (err !== null) return err;
		}
		return null;
	}

	if (LEAF_TYPES.has(type)) {
		return null;
	}

	if (type === "ERROR") {
		return { kind: "too-complex", reason: "Parse error" };
	}

	if (DANGEROUS_TYPES.has(type)) {
		return { kind: "too-complex", reason: `Contains ${type}` };
	}

	return { kind: "too-complex", reason: `Unhandled node type: ${type}` };
}

function isEvalLikeDeclaration(text: string): boolean {
	const m = /\b(declare|typeset|local)\b/.exec(text);
	if (m === null) return false;
	for (const operand of text.slice(m.index + m[0].length).split(/\s+/)) {
		if (operand === "") continue;
		if (DECLARE_EVAL_FLAG_RE.test(operand)) return true;
		if (operand[0] !== "-" && DECLARE_SUBSCRIPT_RE.test(operand)) {
			return true;
		}
	}
	return false;
}
