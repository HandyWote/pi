import type { ExtensionCommandContext, Theme } from "@handy_wote/pi-coding-agent";
import {
	type Component,
	EntityList,
	type EntityListTheme,
	type Focusable,
	type Keybindings,
	type KeybindingsManager,
	truncateToWidth,
} from "@handy_wote/pi-tui";
import type { AgentManager } from "./manager.ts";
import { formatAgentRow, formatDuration } from "./render.ts";
import { type AgentDefinition, type AgentRecord, type AgentStatus, isTerminalStatus } from "./types.ts";

const MAX_LIST_VISIBLE = 12;
const MAX_ACTIVITIES = 10;

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

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function formatUsage(record: AgentRecord): string {
	const usage = record.usage;
	return [
		`input ${formatTokens(usage.input)}`,
		`output ${formatTokens(usage.output)}`,
		`cacheRead ${formatTokens(usage.cacheRead)}`,
		`cacheWrite ${formatTokens(usage.cacheWrite)}`,
		`cost $${usage.cost.toFixed(4)}`,
		`turns ${usage.turns}`,
		`context ${formatTokens(usage.contextTokens)}`,
	].join(" · ");
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
	done: (result: undefined) => void;
}

/**
 * Interactive agent management view shown by `/agents` in TUI mode.
 *
 * List layer: active-first rows (reusing `formatAgentRow`) with arrow keys and
 * `/` search via `EntityList`; Enter opens the detail layer.
 *
 * Detail layer: a live status card re-read from `manager.get(agentId)` on every
 * frame (the `AgentPanel` pattern), so usage and duration keep updating while an
 * agent runs.
 *
 * Operations: `x` (`tui.entity.delete`) stops queued/running agents; `r`
 * (`app.agent.resume`) resumes terminal agents, closing the view first so the
 * host approval/input dialogs replace the editor cleanly; Esc returns to the
 * list from detail and closes the view from the list.
 */
class AgentViewComponent implements Component, Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly manager: AgentManager;
	private readonly definitions: readonly AgentDefinition[];
	private readonly projectTrusted: boolean;
	private readonly prompt: AgentViewCallbacks["prompt"];
	private readonly approve: AgentViewCallbacks["approve"];
	private readonly notify: AgentViewCallbacks["notify"];
	private readonly done: (result: undefined) => void;
	private readonly list: EntityList;
	private recordsById = new Map<string, AgentRecord>();
	private listSignature = "";
	private layer: "list" | "detail" = "list";
	private detailAgentId: string | undefined;
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
		this.manager = options.manager;
		this.definitions = options.definitions;
		this.projectTrusted = options.projectTrusted;
		this.prompt = options.prompt;
		this.approve = options.approve;
		this.notify = options.notify;
		this.done = options.done;

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
			this.layer = "list";
			this.detailAgentId = undefined;
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
	}

	private async stopRecord(record: AgentRecord): Promise<void> {
		try {
			const stopped = await this.manager.stop(record.agentId);
			this.notify(`${stopped.agentId} stopped`, "info");
		} catch (error: unknown) {
			this.notify(error instanceof Error ? error.message : String(error), "error");
		}
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
		const lines: string[] = [truncateToWidth(this.theme.fg("accent", this.theme.bold("Agents · detail")), width)];
		if (!record) {
			lines.push(this.theme.fg("muted", "Agent no longer exists"));
			return lines;
		}
		const label = record.definition.displayName ?? record.definition.name;
		lines.push(
			truncateToWidth(
				`${this.theme.fg(statusColor(record.status), record.status)} ${this.theme.fg("accent", label)}`,
				width,
			),
		);
		lines.push("");
		lines.push(this.keyValue("Task", record.task, width));
		lines.push(this.keyValue("agentId", record.agentId, width));
		lines.push(this.keyValue("status", record.status, width));
		lines.push(this.keyValue("cwd", record.cwd, width));
		lines.push(this.keyValue("isolation", record.isolation, width));
		lines.push(this.keyValue("model", record.model ?? record.definition.model ?? "main", width));
		lines.push(this.keyValue("usage", formatUsage(record), width));
		lines.push(this.keyValue("duration", formatDuration(record), width));
		const activities = record.activities.slice(-MAX_ACTIVITIES);
		if (activities.length > 0) {
			lines.push(this.theme.fg("muted", "Activities:"));
			for (const activity of activities) {
				const prefix = activity.type === "tool" ? "> " : "  ";
				lines.push(truncateToWidth(this.theme.fg("dim", `${prefix}${activity.text}`), width));
			}
		}
		if (record.error) lines.push(this.keyValue("Error", record.error.trim(), width));
		lines.push(this.keyValue("transcript", record.transcriptPath, width));
		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", this.detailFooter(record)), width));
		return lines;
	}

	private keyValue(key: string, value: string, width: number): string {
		return truncateToWidth(`${this.theme.fg("muted", `${key}:`)} ${value}`, width);
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
		const hints = [keyHint(this.keybindings, "tui.entity.cancel", "back")];
		if (isActiveStatus(record.status)) hints.push(keyHint(this.keybindings, "tui.entity.delete", "stop"));
		if (isTerminalStatus(record.status)) hints.push(keyHint(this.keybindings, "app.agent.resume", "resume"));
		return hints.join(" · ");
	}
}

/**
 * Open the interactive agent management view. Only call in TUI mode; `ctx.ui.custom`
 * is not available in RPC mode (which keeps the existing select-menu flow).
 */
export function openAgentView(ctx: ExtensionCommandContext, options: AgentViewOptions): Promise<undefined> {
	return ctx.ui.custom<undefined>((_tui, theme, keybindings, done) => {
		return new AgentViewComponent({ ...options, theme, keybindings, done });
	});
}
