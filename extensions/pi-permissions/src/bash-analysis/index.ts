/**
 * Bash command static analysis: tree-sitter WASM parsing plus semantic
 * checks on the resulting command list (Claude Code-style, implemented
 * from scratch).
 */

export {
	type BashParseResult,
	parseBashCommand,
} from "./parser.ts";
export { checkSemantics, type SemanticsResult } from "./semantics.ts";
