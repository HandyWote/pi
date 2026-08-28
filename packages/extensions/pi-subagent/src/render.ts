import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	Theme,
	ToolRenderResultOptions,
} from "@handy_wote/pi-coding-agent";
import { Box, type Component, Spacer, Text, truncateToWidth } from "@handy_wote/pi-tui";
import type { AgentManager } from "./manager.ts";
import type { AgentRecord, AgentSource, AgentStatus, AgentTerminalStatus } from "./types.ts";

export const AGENT_PANEL_WIDGET_KEY = "pi-subagent-agents";
export const NOTIFICATION_CUSTOM_TYPE = "pi-subagent-notification";

const PANEL_TASK_LIMIT = 40;
const CARD_TASK_LIMIT = 200;
const AGENT_PANEL_MAX_ROWS = 8;

/** Terminal notification payload normalized from `details` or, failing that, message text. */
interface NotificationEntry {
	agentId: string;
	definition?: string;
	status: AgentTerminalStatus;
	task?: string;
	result?: string;
	usage?: { input: number; output: number; toolCount: number };
	transcriptPath?: string;
}

export interface AgentDefinitionSummary {
	name: string;
	source: AgentSource;
	description: string;
}

export interface AgentToolDetails {
	operation: "start" | "list" | "output" | "stop" | "resume";
	records: AgentRecord[];
	definitions?: AgentDefinitionSummary[];
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

function truncateText(value: string, limit: number): string {
	// Tasks are multi-line prompt text; flatten to a single line so rows rendered
	// as one terminal line do not break the diff-renderer line model.
	const singleLine = value.replace(/\s*\n\s*/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "queued":
			return "○";
		case "running":
			return "●";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "stopped":
			return "■";
		case "interrupted":
			return "■";
	}
}

function statusGlyphColor(status: AgentStatus): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "running":
		case "stopped":
		case "interrupted":
			return "warning";
		case "queued":
			return "muted";
	}
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
	const model = record.model ?? record.definition.model ?? "main";
	const summary = `${label} | ${record.status} | ${record.toolCount} tools | ${formatTokens(tokens)} tokens | ${formatDuration(record)} | model ${model}`;
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

// ============================================================================
// Notification card (registerMessageRenderer)
// ============================================================================

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalStatus(value: unknown): value is AgentTerminalStatus {
	return value === "completed" || value === "failed" || value === "stopped" || value === "interrupted";
}

function extractMessageText(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isObject(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function normalizeDetailsEntry(value: unknown): NotificationEntry | undefined {
	if (!isObject(value)) return undefined;
	const { agentId, status } = value;
	if (typeof agentId !== "string" || !isTerminalStatus(status)) return undefined;
	const definition = typeof value.definition === "string" ? value.definition : undefined;
	const task = typeof value.task === "string" ? value.task : undefined;
	const result = typeof value.result === "string" ? value.result : undefined;
	const transcriptPath = typeof value.transcriptPath === "string" ? value.transcriptPath : undefined;
	let usage: NotificationEntry["usage"];
	if (isObject(value.usage)) {
		const input = typeof value.usage.input === "number" ? value.usage.input : 0;
		const output = typeof value.usage.output === "number" ? value.usage.output : 0;
		const toolCount = typeof value.usage.toolCount === "number" ? value.usage.toolCount : 0;
		usage = { input, output, toolCount };
	}
	return { agentId, definition, status, task, result, transcriptPath, usage };
}

const BATCH_ENTRY_PATTERN =
	/^\d+\. Subagent (\S+) \(([^)]*)\) (completed|failed|stopped|interrupted)\. Task: (.+?)\. (?:Continue|Stop):/;
const LEGACY_BATCH_ENTRY_PATTERN = /^\d+\. Subagent (\S+) \(([^)]*)\) (completed|failed|stopped|interrupted)\.$/;
const SINGLE_STATUS_PATTERN =
	/^(?:Agent "([^"]*)"|Subagent (\S+) \(([^)]*)\)) (completed|failed|stopped|interrupted)\.$/;

function parseLegacyUsage(line: string | undefined): NotificationEntry["usage"] {
	if (!line) return undefined;
	const match = /(\d+) tools?, ([\d,]+) tokens?/.exec(line);
	if (!match) return undefined;
	return { input: Number(match[2]!.replace(/,/g, "")), output: 0, toolCount: Number(match[1]!) };
}

/** Parse the human-readable `content` of a notification (used when `details` are missing or sparse). */
function parseNotificationContent(content: string): NotificationEntry[] {
	const lines = content.split("\n");
	const entries: NotificationEntry[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const match = BATCH_ENTRY_PATTERN.exec(line);
		if (match) {
			entries.push({
				agentId: match[1]!,
				definition: match[2]!,
				status: match[3] as AgentTerminalStatus,
				task: match[4]!.trim(),
			});
			continue;
		}
		const legacy = LEGACY_BATCH_ENTRY_PATTERN.exec(line);
		if (legacy) {
			const taskLine = lines[index + 1]?.trim();
			entries.push({
				agentId: legacy[1]!,
				definition: legacy[2]!,
				status: legacy[3] as AgentTerminalStatus,
				task: taskLine?.startsWith("Task: ") ? taskLine.slice("Task: ".length) : undefined,
			});
		}
	}
	if (entries.length > 0) return entries;
	const statusLine = lines.map((line) => line.trim()).find((line) => SINGLE_STATUS_PATTERN.test(line));
	if (!statusLine) return [];
	const single = SINGLE_STATUS_PATTERN.exec(statusLine)!;
	const resumeLine = lines.find((line) => line.includes("agent_resume "));
	return [
		{
			agentId: single[2] ?? resumeLine?.match(/agent_resume (\S+)/)?.[1] ?? "",
			definition: single[1] ?? single[3] ?? "",
			status: single[4] as AgentTerminalStatus,
			task: lines
				.find((line) => line.trim().startsWith("Task: "))
				?.trim()
				.slice("Task: ".length),
			result: lines
				.find((line) => line.trim().startsWith("Recorded result: "))
				?.trim()
				.slice("Recorded result: ".length),
			transcriptPath: lines
				.find((line) => line.trim().startsWith("Output: "))
				?.trim()
				.slice("Output: ".length),
			usage: parseLegacyUsage(lines.find((line) => line.trim().startsWith("Usage: "))),
		},
	];
}

/**
 * Prefer the structured `details` payload; fall back to parsing the message
 * text so older notifications (sparse details or none) still render a card.
 */
function normalizeNotificationEntries(message: { details?: unknown; content: unknown }): NotificationEntry[] {
	const details = message.details;
	let entries: NotificationEntry[] = [];
	if (Array.isArray(details)) {
		entries = details.map(normalizeDetailsEntry).filter((entry): entry is NotificationEntry => entry !== undefined);
	} else {
		const entry = normalizeDetailsEntry(details);
		if (entry) entries = [entry];
	}
	if (entries.length > 0 && entries.every((entry) => entry.task)) return entries;
	const parsed = parseNotificationContent(extractMessageText(message));
	if (parsed.length > 0) return parsed;
	return entries;
}

function notificationCardLines(entry: NotificationEntry, theme: Theme, expanded: boolean): string {
	const agent = entry.definition || entry.agentId;
	const heading = `${theme.fg(statusGlyphColor(entry.status), `${statusGlyph(entry.status)} ${entry.status}`)} ${theme.fg("accent", agent)}${entry.agentId && entry.agentId !== agent ? theme.fg("dim", ` ${entry.agentId}`) : ""}`;
	const lines = [heading];
	if (entry.task) lines.push(`${theme.fg("muted", "Task:")} ${truncateText(entry.task, CARD_TASK_LIMIT)}`);
	const meta: string[] = [];
	if (entry.usage)
		meta.push(`${entry.usage.toolCount} tools`, `${formatTokens(entry.usage.input + entry.usage.output)} tokens`);
	if (entry.transcriptPath) meta.push(entry.transcriptPath);
	if (meta.length > 0) lines.push(theme.fg("dim", meta.join(" · ")));
	if (expanded && entry.result?.trim()) {
		lines.push(theme.fg("muted", "Result:"));
		lines.push(theme.fg("toolOutput", entry.result.trim()));
	}
	return lines.join("\n");
}

const renderTerminalNotification: MessageRenderer = (message, options, theme) => {
	const entries = normalizeNotificationEntries(message);
	if (entries.length === 0) {
		const text = extractMessageText(message);
		return text ? new Text(text, 1, 1) : undefined;
	}
	const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
	if (entries.length > 1) {
		box.addChild(new Text(theme.fg("accent", `${entries.length} subagents reached terminal state`), 0, 0));
		box.addChild(new Spacer(1));
	}
	for (let index = 0; index < entries.length; index++) {
		if (index > 0) box.addChild(new Spacer(1));
		box.addChild(new Text(notificationCardLines(entries[index]!, theme, options.expanded), 0, 0));
	}
	return box;
};

/**
 * Register the `pi-subagent-notification` card renderer.
 * Call once per extension factory invocation (next to registerAgentTools).
 */
export function registerNotificationCard(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(NOTIFICATION_CUSTOM_TYPE, renderTerminalNotification);
}

// ============================================================================
// Persistent agent panel (setWidget)
// ============================================================================

function isActiveStatus(status: AgentStatus): boolean {
	return status === "queued" || status === "running";
}

function comparePanelRecords(a: AgentRecord, b: AgentRecord): number {
	const activeA = isActiveStatus(a.status) ? 0 : 1;
	const activeB = isActiveStatus(b.status) ? 0 : 1;
	if (activeA !== activeB) return activeA - activeB;
	const timeA = Date.parse(isActiveStatus(a.status) ? a.createdAt : (a.endedAt ?? a.updatedAt));
	const timeB = Date.parse(isActiveStatus(b.status) ? b.createdAt : (b.endedAt ?? b.updatedAt));
	return timeB - timeA;
}

/**
 * Live row text for the panel: latest assistant output, else the most recent
 * activity (tool call or text), else the launch task before anything happens.
 * Multi-line text is flattened to a single line for the one-row-per-record
 * line model.
 */
function panelRowText(record: AgentRecord): string {
	const lastOutput = record.lastOutput.trim();
	if (lastOutput) return truncateText(lastOutput, PANEL_TASK_LIMIT);
	const lastActivity = record.activities.at(-1);
	if (lastActivity) return truncateText(lastActivity.text, PANEL_TASK_LIMIT);
	return truncateText(record.task, PANEL_TASK_LIMIT);
}

function formatPanelRow(record: AgentRecord, theme: Theme, width: number): string {
	const label = record.definition.displayName ?? record.definition.name;
	const tokens = record.usage.input + record.usage.output;
	const row = ` ${theme.fg(statusGlyphColor(record.status), statusGlyph(record.status))} ${theme.fg("accent", label)} ${theme.fg("dim", panelRowText(record))} | ${record.toolCount} tools | ${formatTokens(tokens)} tok | ${formatDuration(record)}`;
	return truncateToWidth(row, Math.max(1, width));
}

/**
 * Live agent list widget shown above the editor. Rows are recomputed from the
 * manager registry on every frame, so no event-driven refresh is required
 * while the widget is registered.
 */
export class AgentPanel implements Component {
	private readonly manager: AgentManager;
	private readonly theme: Theme;
	private readonly maxRows: number;

	constructor(manager: AgentManager, theme: Theme, maxRows: number = AGENT_PANEL_MAX_ROWS) {
		this.manager = manager;
		this.theme = theme;
		this.maxRows = maxRows;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const records = this.manager.list();
		if (records.length === 0) return [];
		const safeWidth = Math.max(1, width);
		// The panel tracks queued/running agents only; terminal rows drop out
		// immediately ("use and go"). Records stay in the registry for `/agents`
		// and resume, but the widget renders nothing once no active agent remains.
		const active = records.filter((record) => isActiveStatus(record.status));
		if (active.length === 0) return [];
		const ordered = [...active].sort(comparePanelRecords);
		const lines = [
			truncateToWidth(
				`${this.theme.fg("accent", "pi-subagent")} ${this.theme.fg("dim", `· ${ordered.length} active`)}`,
				safeWidth,
			),
		];
		for (const record of ordered.slice(0, this.maxRows)) {
			lines.push(formatPanelRow(record, this.theme, safeWidth));
		}
		if (ordered.length > this.maxRows) {
			lines.push(truncateToWidth(this.theme.fg("dim", `+${ordered.length - this.maxRows} more`), safeWidth));
		}
		return lines;
	}
}

/**
 * Show or hide the persistent agent panel above the editor.
 *
 * Called from `updateStatus()` in `index.ts` on `session_start` and on every
 * lifecycle/terminal event. The panel component reads live manager state on
 * every render, so repeat calls are cheap and no activity subscription is
 * needed inside this module. The widget stays registered while any record
 * exists so terminal rows never flash back; `AgentPanel.render` filters to
 * active records, so the widget renders nothing once no active agent remains.
 */
export function registerAgentPanel(ctx: ExtensionContext, manager: AgentManager | undefined): void {
	if (!ctx.hasUI) return;
	if (!manager || manager.list().length === 0) {
		ctx.ui.setWidget(AGENT_PANEL_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(AGENT_PANEL_WIDGET_KEY, (_tui, theme) => new AgentPanel(manager, theme));
}

export function renderAgentResult(
	details: AgentToolDetails | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	if (!details) return new BoundedText(theme.fg("muted", "No agent details"));
	if (details.error) return new BoundedText(theme.fg("error", details.error));
	if (details.records.length === 0 && !details.definitions?.length)
		return new BoundedText(theme.fg("muted", "No agents"));
	const sections: string[] = [];
	if (details.definitions?.length) {
		sections.push(
			details.definitions
				.map(
					(definition) =>
						`${theme.fg("accent", definition.name)} ${theme.fg("dim", `[${definition.source}]`)} ${definition.description}`,
				)
				.join("\n"),
		);
	}
	if (details.records.length)
		sections.push(details.records.map((record) => renderRecord(record, options.expanded, theme)).join("\n\n"));
	let text = sections.join("\n\n");
	if (details.operation === "output" && details.transcript && options.expanded) {
		text += `\n\n${theme.fg("muted", "Transcript")}`;
		text += `\n${theme.fg("toolOutput", details.transcript.trim())}`;
	}
	if (!options.expanded && details.records.some((record) => record.activities.length > 1)) {
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new BoundedText(text);
}
