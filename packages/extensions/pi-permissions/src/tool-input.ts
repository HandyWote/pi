/**
 * Normalize a tool_call event into the fields the gate needs: the tool name,
 * the bash command (if any) and the file paths the call touches.
 */

import type { ToolCallEvent } from "@handy_wote/pi-coding-agent";

export interface ToolCallInfo {
	toolName: string;
	/** Bash command, when the tool is bash. */
	command?: string;
	/** File paths the call reads or writes (edit/write/read/grep/find/ls). */
	paths: string[];
	/** Short human-readable description of the call. */
	description: string;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function extractToolCallInfo(event: ToolCallEvent): ToolCallInfo {
	const toolName = event.toolName;
	const input = event.input as Record<string, unknown>;

	switch (toolName) {
		case "bash": {
			const command = str(input.command) ?? "";
			return { toolName, command, paths: extractBashWritePaths(command), description: command };
		}
		case "edit":
		case "write": {
			const p = str(input.path) ?? "";
			return { toolName, paths: p ? [p] : [], description: p };
		}
		case "read": {
			const p = str(input.path) ?? "";
			return { toolName, paths: p ? [p] : [], description: p };
		}
		case "grep":
		case "find":
		case "ls": {
			const p = str(input.path) ?? "";
			return { toolName, paths: p ? [p] : [], description: p || "(current directory)" };
		}
		default: {
			// Custom tools: no path/command extraction (v1 treats them by name).
			return { toolName, paths: [], description: toolName };
		}
	}
}

/**
 * Extract literal targets of common shell write operations. This is only
 * used for redlines; dynamic shell expressions remain subject to the bash
 * parser's fail-closed path.
 */
function extractBashWritePaths(command: string): string[] {
	const paths = new Set<string>();
	const redirect = /(?:^|\s)(?:[0-9]+)?(?:>>|>|>\||&>>|&>)\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g;
	for (const match of command.matchAll(redirect)) {
		const target = unquote(match[1] ?? "");
		if (target !== "") paths.add(target);
	}

	const writeCommands = new Set([
		"chmod",
		"chown",
		"cp",
		"install",
		"ln",
		"mkdir",
		"mv",
		"rm",
		"rmdir",
		"sed",
		"tee",
		"touch",
		"truncate",
	]);
	for (const segment of command.split(/(?:&&|\|\||[;|])/)) {
		const words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		const commandIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
		if (commandIndex === -1 || !writeCommands.has(unquote(words[commandIndex] ?? ""))) continue;
		for (const word of words.slice(commandIndex + 1)) {
			const target = unquote(word);
			if (target !== "" && !target.startsWith("-")) paths.add(target);
		}
	}

	return [...paths];
}

function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}
