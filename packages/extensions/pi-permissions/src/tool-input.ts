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
			return { toolName, command, paths: [], description: command };
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
