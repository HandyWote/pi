import type { Theme, ToolRenderResultOptions } from "@handy_wote/pi-coding-agent";
import { Text, truncateToWidth } from "@handy_wote/pi-tui";
import type { AgentRecord } from "./types.ts";

export interface AgentToolDetails {
	operation: "start" | "list" | "output" | "stop" | "resume";
	records: AgentRecord[];
	transcript?: string;
	ready?: boolean;
	error?: string;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

export function formatDuration(record: AgentRecord, now = Date.now()): string {
	const start = Date.parse(record.startedAt ?? record.createdAt);
	const end = record.endedAt ? Date.parse(record.endedAt) : now;
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatAgentRow(record: AgentRecord, width: number): string {
	const label = record.definition.displayName ?? record.definition.name;
	const tokens = record.usage.input + record.usage.output;
	const summary = `${label} | ${record.status} | ${record.toolCount} tools | ${formatTokens(tokens)} tokens | ${formatDuration(record)}`;
	return truncateToWidth(summary, Math.max(1, width));
}

function statusColor(record: AgentRecord): "success" | "error" | "warning" | "muted" {
	if (record.status === "completed") return "success";
	if (record.status === "failed" || record.status === "stopped") return "error";
	if (record.status === "running" || record.status === "queued") return "warning";
	return "muted";
}

function renderRecord(record: AgentRecord, expanded: boolean, theme: Theme): string {
	const label = record.definition.displayName ?? record.definition.name;
	const tokens = record.usage.input + record.usage.output;
	let text = `${theme.fg(statusColor(record), record.status)} ${theme.fg("accent", label)}`;
	text += theme.fg(
		"dim",
		` | ${record.agentId} | ${record.toolCount} tools | ${formatTokens(tokens)} tokens | ${formatDuration(record)}`,
	);
	if (expanded) {
		text += `\n${theme.fg("muted", "Task: ")}${record.task}`;
		for (const activity of record.activities) {
			const prefix = activity.type === "tool" ? ">" : " ";
			text += `\n${theme.fg("dim", `${prefix} ${activity.text}`)}`;
		}
		if (record.error) text += `\n${theme.fg("error", record.error.trim())}`;
		if (record.cleanupError) text += `\n${theme.fg("warning", `Worktree retained: ${record.cleanupError}`)}`;
	} else if (record.activities.length > 0) {
		text += `\n${theme.fg("dim", record.activities.at(-1)?.text ?? "")}`;
	}
	return text;
}

export function renderAgentResult(
	details: AgentToolDetails | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (!details) return new Text(theme.fg("muted", "No agent details"), 0, 0);
	if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
	if (details.records.length === 0) return new Text(theme.fg("muted", "No agents"), 0, 0);
	let text = details.records.map((record) => renderRecord(record, options.expanded, theme)).join("\n\n");
	if (details.operation === "output" && details.transcript && options.expanded) {
		text += `\n\n${theme.fg("muted", "Transcript")}`;
		text += `\n${theme.fg("toolOutput", details.transcript.trim())}`;
	}
	if (!options.expanded && details.records.some((record) => record.activities.length > 1)) {
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new Text(text, 0, 0);
}
