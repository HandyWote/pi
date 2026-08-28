import { type ExtensionCommandContext, getMarkdownTheme, type Theme } from "@handy_wote/pi-coding-agent";
import {
	type Component,
	EntityList,
	type EntityListTheme,
	type Focusable,
	type Keybindings,
	type KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	type TUI,
	truncateToWidth,
} from "@handy_wote/pi-tui";
import type { AgentManager } from "./manager.ts";
import { formatAgentRow, formatDuration } from "./render.ts";
import { TranscriptCache, type TranscriptItem } from "./transcript-view.ts";
import { type AgentDefinition, type AgentRecord, type AgentStatus, isTerminalStatus } from "./types.ts";

const MAX_LIST_VISIBLE = 12;
/** Border + header + task + border + footer rows outside the transcript body. */
const DETAIL_CHROME_ROWS = 5;
/** Fallback viewport height when the terminal height cannot be read. */
const FALLBACK_VIEWPORT = 20;
/** Poll cadence for transcript refresh while the detail view is open. */
const REFRESH_INTERVAL_MS = 250;
/** Maximum transcript items rendered (protects long sessions). */
const MAX_DETAIL_ITEMS = 500;

function isActiveStatus(status: AgentStatus): boolean {
	return status === "queued" || status === "running";
}

/** Replicate the active-first ordering used by the persistent agent panel. */
function compareRecords(a: AgentRecord, b: AgentRecord): number {
	const activeA = isActiveStatus(a.status) ? 0 : 1;
	const activeB = isActiveStatus(b.status) ? 0 : 1;
	if (activeA !== activeB) return activeA - activeB;
	const timeA = Date.parse(isActiveStatus(a.status) ? a.createdAt : (a.endedAt ?? a.updatedAt));
	const timeB = Date.parse(isActiveStatus(b.status) ? b.createdAt : (b.endedAt ?? b.updatedAt));
	return timeB - timeA;
}

function statusColor(status: AgentStatus): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
		case "stopped":
			return "error";
		case "running":
		case "queued":
			return "warning";
		default:
			return "muted";
	}
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
		case "interrupted":
			return "■";
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function formatKeyPart(part: string): string {
	return part.charAt(0).toUpperCase() + part.slice(1);
}

function keyHint(keybindings: KeybindingsManager, binding: keyof Keybindings, description: string): string {
	const formatted = keybindings
		.getKeys(binding)
		.join("/")
		.split("/")
		.map((combo) => combo.split("+").map(formatKeyPart).join("+"))
		.join("/");
	return description ? `${formatted} ${description}` : formatted;
}

function entityListTheme(theme: Theme): EntityListTheme {
	return {
		title: (text) => theme.fg("accent", theme.bold(text)),
		cursor: (text) => theme.fg("accent", text),
		selected: (text) => theme.fg("accent", text),
		label: (text) => theme.fg("text", text),
		description: (text) => theme.fg("muted", text),
		toggled: (text) => theme.fg("success", text),
		untoggled: (text) => theme.fg("dim", text),
		hint: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
		deletePending: (text) => theme.fg("error", text),
	};
}

/** Callbacks owned by the command handler so the view stays decoupled from `ctx`. */
export interface AgentViewCallbacks {
	/** Obtain resume instructions via the host input dialog (`ctx.ui.input`). */
	prompt: (title: string, placeholder?: string) => Promise<string | undefined>;
	/** Approve project-local agents before resume (mirrors the non-TUI flow). */
	approve: (definitions: readonly AgentDefinition[]) => Promise<void>;
	/** Surface operation results without a blocking dialog (`ctx.ui.notify`). */
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

export interface AgentViewOptions extends AgentViewCallbacks {
	manager: AgentManager;
	definitions: readonly AgentDefinition[];
	projectTrusted: boolean;
}

interface ComponentOptions extends AgentViewOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	tui: TUI;
	done: (result: undefined) => void;
}

/**
 * Interactive agent management view shown by `/agents` in TUI mode.
 *
 * List layer: active-first rows (reusing `formatAgentRow`) with arrow keys and
 * `/` search via `EntityList`; Enter opens the detail layer.
 *
 * Detail layer: a live, scrollable transcript card styled like the main
 * session. The header (status glyph, usage, duration) re-reads
 * `manager.get(agentId)` every frame; the body renders transcript items
 * (assistant text via Markdown, compact tool-call rows, dim result rows)
 * incrementally parsed from the child transcript file, polled on a timer
 * while the layer is open. Running agents auto-follow the tail; scrolling up
 * pauses the follow and `G` re-enables it.
 *
 * Operations: `x` (`tui.entity.delete`) stops queued/running agents; `r`
 * (`app.agent.resume`) resumes terminal agents, closing the view first so the
 * host approval/input dialogs replace the editor cleanly; Esc returns to the
 * list from detail and closes the view from the list.
 */
export class AgentViewComponent implements Component, Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly manager: AgentManager;
	private readonly definitions: readonly AgentDefinition[];
	private readonly projectTrusted: boolean;
	private readonly prompt: AgentViewCallbacks["prompt"];
	private readonly approve: AgentViewCallbacks["approve"];
	private readonly notify: AgentViewCallbacks["notify"];
	private readonly done: (result: undefined) => void;
	private readonly list: EntityList;
	private readonly transcriptCache = new TranscriptCache();
	private readonly markdownTheme: MarkdownTheme;
	private recordsById = new Map<string, AgentRecord>();
	private listSignature = "";
	private layer: "list" | "detail" = "list";
	private detailAgentId: string | undefined;
	private detailItems: TranscriptItem[] = [];
	private scrollTop = 0;
	private followTail = true;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.list.focused = value;
	}

	constructor(options: ComponentOptions) {
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.tui = options.tui;
		this.manager = options.manager;
		this.definitions = options.definitions;
		this.projectTrusted = options.projectTrusted;
		this.prompt = options.prompt;
		this.approve = options.approve;
		this.notify = options.notify;
		this.done = options.done;
		this.markdownTheme = getMarkdownTheme();

		this.list = new EntityList([], {
			theme: entityListTheme(options.theme),
			maxVisible: MAX_LIST_VISIBLE,
			searchable: true,
			getSearchText: (item) => {
				const record = this.recordsById.get(item.id);
				return record
					? `${record.definition.name} ${record.definition.displayName ?? ""} ${record.task} ${record.agentId} ${record.status} ${record.model ?? ""}`
					: item.id;
			},
			renderItem: ({ item, selected, width }) => {
				const record = this.recordsById.get(item.id);
				if (!record) return "";
				const summary = formatAgentRow(record, Math.max(1, width - 2));
				const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
				return cursor + (selected ? this.theme.fg("accent", summary) : summary);
			},
			renderEmpty: () => [this.theme.fg("muted", "  No subagents yet")],
		});
		this.list.onActivate = (item) => this.openDetail(item.id);
		this.list.onCancel = () => this.done(undefined);
	}

	dispose(): void {
		this.stopRefreshTimer();
		this.transcriptCache.clear();
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return this.layer === "detail" ? this.renderDetail(safeWidth) : this.renderList(safeWidth);
	}

	handleInput(data: string): void {
		if (this.layer === "detail") {
			this.handleDetailInput(data);
			return;
		}
		// While typing a search query, delegate everything (including Escape and
		// Enter) to the EntityList so `/` search behaves normally.
		if (this.list.isSearching()) {
			this.list.handleInput(data);
			return;
		}
		const kb = this.keybindings;
		if (kb.matches(data, "tui.entity.delete")) {
			const record = this.selectedRecord();
			if (record && isActiveStatus(record.status)) void this.stopRecord(record);
			return;
		}
		if (kb.matches(data, "app.agent.resume")) {
			const record = this.selectedRecord();
			if (record && isTerminalStatus(record.status)) this.resumeRecord(record);
			return;
		}
		this.list.handleInput(data);
	}

	private handleDetailInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.entity.cancel") || kb.matches(data, "tui.entity.activate")) {
			this.closeDetail();
			return;
		}
		if (kb.matches(data, "tui.entity.delete")) {
			const record = this.detailRecord();
			if (record && isActiveStatus(record.status)) void this.stopRecord(record);
			return;
		}
		if (kb.matches(data, "app.agent.resume")) {
			const record = this.detailRecord();
			if (record && isTerminalStatus(record.status)) this.resumeRecord(record);
			return;
		}
		// Scroll: up/down (and j/k) by line, pageUp/pageDown by page, G/g jump to
		// end/start. Scrolling up pauses tail-follow; G re-enables it.
		if (kb.matches(data, "tui.entity.up") || data === "j") {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(data, "tui.entity.down") || data === "k") {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollBy(-this.detailViewportHeight());
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollBy(this.detailViewportHeight());
			return;
		}
		if (data === "G") {
			this.followTail = true;
			this.tui.requestRender();
			return;
		}
		if (data === "g") {
			this.followTail = false;
			this.scrollTop = 0;
			this.tui.requestRender();
		}
	}

	private currentRecords(): AgentRecord[] {
		const trusted = this.projectTrusted;
		return this.manager.list().filter((record) => trusted || record.definition.source === "user");
	}

	private syncList(records: readonly AgentRecord[]): void {
		this.recordsById = new Map(records.map((record) => [record.agentId, record]));
		const signature = records.map((record) => record.agentId).join("\0");
		if (signature === this.listSignature) return;
		this.listSignature = signature;
		this.list.setItems(records.map((record) => ({ id: record.agentId, label: record.definition.name })));
	}

	private selectedRecord(): AgentRecord | undefined {
		const item = this.list.getSelectedItem();
		return item ? this.recordsById.get(item.id) : undefined;
	}

	private detailRecord(): AgentRecord | undefined {
		return this.detailAgentId ? this.manager.get(this.detailAgentId) : undefined;
	}

	private openDetail(agentId: string): void {
		this.detailAgentId = agentId;
		this.layer = "detail";
		this.detailItems = [];
		this.scrollTop = 0;
		this.followTail = true;
		void this.refreshTranscript();
		this.startRefreshTimer();
	}

	private closeDetail(): void {
		this.layer = "list";
		this.detailAgentId = undefined;
		this.detailItems = [];
		this.stopRefreshTimer();
	}

	private startRefreshTimer(): void {
		this.stopRefreshTimer();
		this.refreshTimer = setInterval(() => void this.refreshTranscript(), REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	private stopRefreshTimer(): void {
		if (this.refreshTimer !== undefined) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	/**
	 * Pull new transcript items into the cached snapshot. Parsing happens off
	 * the render path: the async fetch resolves, updates state, and requests a
	 * re-render, so `render` always uses the last snapshot (no flicker).
	 */
	private async refreshTranscript(): Promise<void> {
		const record = this.detailRecord();
		if (!record || !this.detailAgentId) return;
		try {
			const items = await this.transcriptCache.getItems(record);
			if (this.layer !== "detail" || this.detailAgentId !== record.agentId) return;
			this.detailItems = items.slice(-MAX_DETAIL_ITEMS);
			this.tui.requestRender();
		} catch {
			// Transient read errors keep the last snapshot; the timer retries.
		}
	}

	/** Rendered lines of the transcript body (header/task/footer excluded). */
	private detailBodyLines(width: number): string[] {
		const lines: string[] = [];
		for (const item of this.detailItems) {
			if (item.kind === "text") {
				const markdown = new Markdown(item.text.trim(), 0, 0, this.markdownTheme);
				lines.push(...markdown.render(width));
				lines.push("");
			} else if (item.kind === "toolCall") {
				lines.push(truncateToWidth(`${this.theme.fg("accent", item.name)} ${item.summary}`, width));
			} else {
				const glyph = item.isError ? this.theme.fg("error", "✗") : this.theme.fg("dim", "·");
				const text = item.isError ? this.theme.fg("error", item.summary) : this.theme.fg("dim", item.summary);
				lines.push(truncateToWidth(`${glyph} ${text}`, width));
			}
		}
		return lines;
	}

	private detailViewportHeight(): number {
		const rows = this.tui.terminal.rows;
		return Math.max(1, (rows > 0 ? rows : FALLBACK_VIEWPORT) - DETAIL_CHROME_ROWS);
	}

	private scrollBy(delta: number): void {
		if (delta < 0) this.followTail = false;
		this.scrollTop = Math.max(0, this.scrollTop + delta);
		this.tui.requestRender();
	}

	private renderList(width: number): string[] {
		const records = this.currentRecords().sort(compareRecords);
		this.syncList(records);
		const active = records.filter((record) => isActiveStatus(record.status)).length;
		const lines: string[] = [
			truncateToWidth(
				`${this.theme.fg("accent", this.theme.bold("Agents"))}${this.theme.fg("dim", ` · ${active} active · ${records.length} total`)}`,
				width,
			),
		];
		if (this.definitions.length > 0) {
			for (const definition of this.definitions) {
				lines.push(
					truncateToWidth(
						this.theme.fg("muted", `${definition.name} [${definition.source}] — ${definition.description}`),
						width,
					),
				);
			}
			lines.push("");
		}
		lines.push(...this.list.render(width));
		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", this.listFooter()), width));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const record = this.detailRecord();
		const border = (text: string) => this.theme.fg("border", text);
		const lines: string[] = [border("─".repeat(width))];
		if (!record) {
			lines.push(this.theme.fg("muted", "Agent no longer exists"));
			lines.push(border("─".repeat(width)));
			return lines;
		}
		const label = record.definition.displayName ?? record.definition.name;
		const tokens = record.usage.input + record.usage.output;
		lines.push(
			truncateToWidth(
				`${this.theme.fg(statusColor(record.status), `${statusGlyph(record.status)} ${record.status}`)} ${this.theme.fg("accent", label)} ${this.theme.fg("dim", `| ${record.toolCount} tools | ${formatTokens(tokens)} tok | ${formatDuration(record)}`)}`,
				width,
			),
		);
		const task = record.task.replace(/\s*\n\s*/g, " ").trim();
		if (task) lines.push(truncateToWidth(this.theme.fg("muted", `Task: ${task}`), width));
		lines.push(border("─".repeat(width)));

		const body = this.detailBodyLines(width);
		const viewport = this.detailViewportHeight();
		const maxTop = Math.max(0, body.length - viewport);
		if (this.followTail || this.scrollTop > maxTop) this.scrollTop = maxTop;
		const from = this.scrollTop;
		for (const line of body.slice(from, from + viewport)) lines.push(line);

		lines.push(border("─".repeat(width)));
		const scrollInfo =
			body.length > viewport ? ` · ${from + 1}-${Math.min(from + viewport, body.length)}/${body.length}` : "";
		lines.push(truncateToWidth(this.theme.fg("dim", `${this.detailFooter(record)}${scrollInfo}`), width));
		return lines;
	}

	private stopRecord(record: AgentRecord): Promise<void> {
		return this.manager.stop(record.agentId).then(
			(stopped) => this.notify(`${stopped.agentId} stopped`, "info"),
			(error: unknown) => this.notify(error instanceof Error ? error.message : String(error), "error"),
		);
	}

	private resumeRecord(record: AgentRecord): void {
		// Resume opens modal dialogs (approval + prompt) that replace the editor,
		// so close this view first and run the flow detached.
		this.done(undefined);
		void this.runResume(record);
	}

	private async runResume(record: AgentRecord): Promise<void> {
		try {
			await this.approve([record.definition]);
			const prompt = await this.prompt("Resume agent", "Additional instructions");
			if (!prompt?.trim()) return;
			const resumed = await this.manager.resume(record.agentId, prompt, "background");
			this.notify(`${resumed.record.agentId} resumed in background`, "info");
		} catch (error: unknown) {
			this.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	private listFooter(): string {
		const record = this.selectedRecord();
		const hints = [
			`${keyHint(this.keybindings, "tui.entity.up", "")}/${keyHint(this.keybindings, "tui.entity.down", "")} navigate`,
			keyHint(this.keybindings, "tui.entity.search", "search"),
			keyHint(this.keybindings, "tui.entity.activate", "detail"),
		];
		if (record && isActiveStatus(record.status)) hints.push(keyHint(this.keybindings, "tui.entity.delete", "stop"));
		if (record && isTerminalStatus(record.status))
			hints.push(keyHint(this.keybindings, "app.agent.resume", "resume"));
		hints.push(keyHint(this.keybindings, "tui.entity.cancel", "close"));
		return hints.join(" · ");
	}

	private detailFooter(record: AgentRecord): string {
		const hints = [
			`${keyHint(this.keybindings, "tui.entity.up", "")}/${keyHint(this.keybindings, "tui.entity.down", "")} scroll`,
			`${keyHint(this.keybindings, "tui.select.pageUp", "")}/${keyHint(this.keybindings, "tui.select.pageDown", "")} page`,
			"G follow",
		];
		if (isActiveStatus(record.status)) hints.push(keyHint(this.keybindings, "tui.entity.delete", "stop"));
		if (isTerminalStatus(record.status)) hints.push(keyHint(this.keybindings, "app.agent.resume", "resume"));
		hints.push(keyHint(this.keybindings, "tui.entity.cancel", "back"));
		return hints.join(" · ");
	}
}

/**
 * Open the interactive agent management view. Only call in TUI mode; `ctx.ui.custom`
 * is not available in RPC mode (which keeps the existing select-menu flow).
 */
export function openAgentView(ctx: ExtensionCommandContext, options: AgentViewOptions): Promise<undefined> {
	return ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		return new AgentViewComponent({ ...options, theme, keybindings, tui, done });
	});
}
