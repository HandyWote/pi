import type { Theme, ToolRenderResultOptions } from "@handy_wote/pi-coding-agent";
import { type Component, truncateToWidth } from "@handy_wote/pi-tui";
import type { AgentRecord } from "./types.ts";

export interface AgentToolDetails {
	operation: "start" | "list" | "output" | "stop" | "resume";
	records: AgentRecord[];
	transcript?: string;
	ready?: boolean;
	error?: string;
}

export class BoundedText implements Component {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return this.text.split("\n").map((line) => truncateToWidth(line, safeWidth));
	}

	invalidate(): void {}
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
): Component {
	if (!details) return new BoundedText(theme.fg("muted", "No agent details"));
	if (details.error) return new BoundedText(theme.fg("error", details.error));
	if (details.records.length === 0) return new BoundedText(theme.fg("muted", "No agents"));
	let text = details.records.map((record) => renderRecord(record, options.expanded, theme)).join("\n\n");
	if (details.operation === "output" && details.transcript && options.expanded) {
		text += `\n\n${theme.fg("muted", "Transcript")}`;
		text += `\n${theme.fg("toolOutput", details.transcript.trim())}`;
	}
	if (!options.expanded && details.records.some((record) => record.activities.length > 1)) {
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new BoundedText(text);
}
