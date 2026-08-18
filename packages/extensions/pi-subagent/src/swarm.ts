import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@handy_wote/pi-coding-agent";
import {
	Container,
	EntityList,
	type EntityListItem,
	type EntityListTheme,
	type Focusable,
	type Keybindings,
	type KeybindingsManager,
	Spacer,
	Text,
} from "@handy_wote/pi-tui";
import { type AgentManager, readWorkerModels, type WorkerModelRef, writeWorkerModels } from "./manager.ts";

const MAX_POOL_DISPLAY = 10;
const SAVE_POOL_ITEM_ID = "__save_pool__";

const CIRCLED_DIGITS = [
	"①",
	"②",
	"③",
	"④",
	"⑤",
	"⑥",
	"⑦",
	"⑧",
	"⑨",
	"⑩",
	"⑪",
	"⑫",
	"⑬",
	"⑭",
	"⑮",
	"⑯",
	"⑰",
	"⑱",
	"⑲",
	"⑳",
];

/**
 * Injected as a user message after the first pool configuration to establish
 * coordinator behavior for the session (L4 orchestration guidance).
 */
const COORDINATOR_GUIDANCE = `You are coordinating a swarm of subagents for this session. Follow these rules:
- Dispatch independent work in one batched agent_start (multiple tool calls in a single message).
- Treat subagent completion notifications as internal signals: act on their details; never acknowledge or thank them.
- Continue workers with agent_resume (context reuse) instead of spawning fresh agents for follow-up work.
- Synthesize findings before delegating follow-up work; do not delegate "based on your findings" follow-ups.
- Never poll agent_output to wait for workers; completion arrives as an event.`;

function referenceOf(ref: { provider: string; id: string }): string {
	return `${ref.provider}/${ref.id}`;
}

function circledNumber(index: number): string {
	return CIRCLED_DIGITS[index] ?? `${index + 1}.`;
}

function formatPoolSummary(refs: readonly WorkerModelRef[]): string {
	if (refs.length === 0) return "worker pool: 0";
	const entries = refs
		.slice(0, MAX_POOL_DISPLAY)
		.map((ref, index) => `${circledNumber(index)} ${referenceOf(ref)}`)
		.join(" ");
	return `worker pool: ${refs.length} · ${entries}${refs.length > MAX_POOL_DISPLAY ? " …" : ""}`;
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

interface WorkerPoolSelectorOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	candidates: readonly WorkerModelRef[];
	initial: readonly WorkerModelRef[];
	done: (refs: WorkerModelRef[] | undefined) => void;
}

/**
 * Interactive worker pool selector: toggle models into the pool (space),
 * reorder with Alt+Up/Down (order is priority: the first entry is used
 * first), activate the trailing [ Save pool ] row to persist the snapshot,
 * Escape cancels. Saving an empty selection clears the pool.
 */
class WorkerPoolSelectorComponent extends Container implements Focusable {
	private readonly keybindings: KeybindingsManager;
	private readonly done: (refs: WorkerModelRef[] | undefined) => void;
	private readonly candidates: readonly WorkerModelRef[];
	private readonly selected: WorkerModelRef[];
	private readonly list: EntityList;
	private readonly detailsText: Text;
	private readonly footerText: Text;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.list.focused = value;
	}

	constructor(options: WorkerPoolSelectorOptions) {
		super();
		this.keybindings = options.keybindings;
		this.done = options.done;
		this.candidates = options.candidates;
		this.selected = options.initial.map((ref) => ({ ...ref }));

		this.addChild(new Text(options.theme.fg("accent", options.theme.bold("Worker Pool Configuration")), 1, 0));
		const reorderHint = `${keyHint(this.keybindings, "app.models.reorderUp", "")}/${keyHint(this.keybindings, "app.models.reorderDown", "")}`;
		this.addChild(
			new Text(
				options.theme.fg(
					"muted",
					`Pool snapshot; ${reorderHint} reorders, ${keyHint(this.keybindings, "tui.entity.activate", "[ Save pool ]")} saves, ${keyHint(this.keybindings, "tui.entity.cancel", "cancels")}. Order is priority.`,
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.list = new EntityList([], {
			theme: entityListTheme(options.theme),
			maxVisible: 8,
			searchable: true,
			getSearchText: (item) => {
				const ref = this.candidates.find((candidate) => referenceOf(candidate) === item.id);
				return ref ? `${ref.provider} ${ref.id} ${ref.label ?? ""}` : item.id;
			},
		});
		this.list.onToggle = (item) => this.toggleModel(item.id);
		this.list.onActivate = (item) => {
			if (item.id === SAVE_POOL_ITEM_ID) this.done([...this.selected]);
		};
		this.list.onCancel = () => this.done(undefined);
		this.list.onSelectionChange = () => this.updateDetails();
		this.list.onSearchChange = () => this.updateDetails();
		this.addChild(this.list);

		this.detailsText = new Text("", 1, 0);
		this.addChild(this.detailsText);
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 1, 0);
		this.addChild(this.footerText);
		this.refresh();
	}

	private buildItems(): EntityListItem[] {
		const selectedIds = new Set(this.selected.map(referenceOf));
		const sorted = [
			...this.selected,
			...this.candidates.filter((candidate) => !selectedIds.has(referenceOf(candidate))),
		];
		return [
			...sorted.map((ref) => ({
				id: referenceOf(ref),
				label: referenceOf(ref),
				description: ref.label,
				toggled: selectedIds.has(referenceOf(ref)),
				toggleable: true,
			})),
			{ id: SAVE_POOL_ITEM_ID, label: "[ Save pool ]" },
		];
	}

	private getFooterText(): string {
		const hints = [
			keyHint(this.keybindings, "tui.entity.toggle", "toggle"),
			keyHint(this.keybindings, "tui.entity.search", "search"),
			keyHint(this.keybindings, "app.models.enableAll", "all"),
			keyHint(this.keybindings, "app.models.clearAll", "clear"),
			`${keyHint(this.keybindings, "app.models.reorderUp", "")}/${keyHint(this.keybindings, "app.models.reorderDown", "")} reorder`,
			keyHint(this.keybindings, "tui.entity.activate", "save"),
			`${this.selected.length}/${this.candidates.length} selected`,
		];
		return hints.join(" · ");
	}

	private updateDetails(): void {
		const selectedId = this.list.getSelectedItem()?.id;
		const ref = selectedId ? this.candidates.find((candidate) => referenceOf(candidate) === selectedId) : undefined;
		this.detailsText.setText(
			ref
				? `\n  Provider: ${ref.provider}\n  Reference: ${referenceOf(ref)}${ref.label ? `\n  Model: ${ref.label}` : ""}`
				: "",
		);
	}

	private refresh(): void {
		this.list.setItems(this.buildItems());
		this.footerText.setText(this.getFooterText());
		this.updateDetails();
	}

	private addModel(reference: string): void {
		const candidate = this.candidates.find((ref) => referenceOf(ref) === reference);
		if (candidate && !this.selected.some((entry) => referenceOf(entry) === reference))
			this.selected.push({ ...candidate });
	}

	private removeModel(reference: string): void {
		const index = this.selected.findIndex((entry) => referenceOf(entry) === reference);
		if (index >= 0) this.selected.splice(index, 1);
	}

	private toggleModel(reference: string): void {
		if (this.selected.some((entry) => referenceOf(entry) === reference)) this.removeModel(reference);
		else this.addModel(reference);
		this.refresh();
	}

	private moveSelected(reference: string, delta: number): boolean {
		const index = this.selected.findIndex((entry) => referenceOf(entry) === reference);
		if (index < 0) return false;
		const target = index + delta;
		if (target < 0 || target >= this.selected.length) return false;
		const swap = this.selected[index];
		this.selected[index] = this.selected[target];
		this.selected[target] = swap;
		return true;
	}

	private setAllSelected(targets: readonly string[], selected: boolean): void {
		const targetIds = new Set(targets);
		for (const candidate of this.candidates) {
			const reference = referenceOf(candidate);
			if (!targetIds.has(reference)) continue;
			if (selected) this.addModel(reference);
			else this.removeModel(reference);
		}
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (this.list.isSearching()) {
			this.list.handleInput(data);
			this.updateDetails();
			return;
		}
		const selectedId = this.list.getSelectedItem()?.id;
		if (selectedId) {
			if (kb.matches(data, "app.models.reorderUp") || kb.matches(data, "app.models.reorderDown")) {
				const delta = kb.matches(data, "app.models.reorderUp") ? -1 : 1;
				if (this.moveSelected(selectedId, delta)) this.refresh();
				return;
			}
			if (kb.matches(data, "app.models.toggleProvider")) {
				const ref = this.candidates.find((candidate) => referenceOf(candidate) === selectedId);
				if (ref) {
					const providerRefs = this.candidates
						.filter((candidate) => candidate.provider === ref.provider)
						.map(referenceOf);
					const allSelected = providerRefs.every((id) => this.selected.some((entry) => referenceOf(entry) === id));
					this.setAllSelected(providerRefs, !allSelected);
					this.refresh();
				}
				return;
			}
		}
		if (kb.matches(data, "app.models.enableAll")) {
			const targets = this.list.getQuery() ? this.list.getFilteredItems().map((item) => item.id) : undefined;
			this.setAllSelected(targets ?? this.candidates.map(referenceOf), true);
			this.refresh();
			return;
		}
		if (kb.matches(data, "app.models.clearAll")) {
			const targets = this.list.getQuery() ? this.list.getFilteredItems().map((item) => item.id) : undefined;
			this.setAllSelected(targets ?? this.selected.map(referenceOf), false);
			this.refresh();
			return;
		}
		this.list.handleInput(data);
		this.updateDetails();
	}
}

/**
 * TUI mode uses a custom multi-select component (toggle + Alt+Up/Down reorder).
 * Trade-off: non-TUI modes (RPC) fall back to sequential ctx.ui.select
 * add/remove rounds without reordering — priority is then the selection order.
 */
async function selectWorkerPool(
	ctx: ExtensionCommandContext,
	candidates: readonly WorkerModelRef[],
	initial: readonly WorkerModelRef[],
): Promise<WorkerModelRef[] | undefined> {
	if (ctx.mode === "tui") {
		return ctx.ui.custom<WorkerModelRef[] | undefined>((_tui, theme, keybindings, done) => {
			return new WorkerPoolSelectorComponent({ theme, keybindings, candidates, initial, done });
		});
	}
	const selected = initial.map((ref) => ({ ...ref }));
	while (true) {
		const poolChoices = selected.map((ref) => `Remove: ${referenceOf(ref)}`);
		const addChoices = candidates
			.filter((candidate) => !selected.some((entry) => referenceOf(entry) === referenceOf(candidate)))
			.map((candidate) => `Add: ${referenceOf(candidate)}`);
		const choice = await ctx.ui.select("Worker pool", [...poolChoices, ...addChoices, "Done — save pool", "Cancel"]);
		if (choice === undefined || choice === "Cancel") return undefined;
		if (choice === "Done — save pool") {
			ctx.ui.notify(
				`${formatPoolSummary(selected)}. Priority is selection order (first entry wins); use the interactive /swarm selector to reorder.`,
				"info",
			);
			return selected;
		}
		if (choice.startsWith("Remove: ")) {
			const reference = choice.slice("Remove: ".length);
			const index = selected.findIndex((entry) => referenceOf(entry) === reference);
			if (index >= 0) selected.splice(index, 1);
			continue;
		}
		if (choice.startsWith("Add: ")) {
			const reference = choice.slice("Add: ".length);
			const candidate = candidates.find((entry) => referenceOf(entry) === reference);
			if (candidate) selected.push({ ...candidate });
		}
	}
}

/**
 * Candidate models for the pool: the session's scoped models when a scope
 * exists, otherwise all available Runtime models. A scope is a convenience
 * source, not a prerequisite.
 */
function workerModelCandidates(ctx: ExtensionCommandContext): WorkerModelRef[] {
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
	const refs: WorkerModelRef[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		const reference = `${model.provider}/${model.id}`;
		if (seen.has(reference)) continue;
		seen.add(reference);
		refs.push({ provider: model.provider, id: model.id, label: model.name });
	}
	return refs;
}

export function registerSwarmCommand(pi: ExtensionAPI, getManager: () => AgentManager | undefined): void {
	pi.registerCommand("swarm", {
		description: "Configure the worker model pool and coordinator behavior",
		handler: async (_args, ctx) => {
			const manager = getManager();
			if (!manager) {
				ctx.ui.notify("Subagent registry is unavailable", "error");
				return;
			}
			const existing = await readWorkerModels(manager.rootDir);
			if (existing.length > 0) {
				ctx.ui.notify(formatPoolSummary(existing), "info");
				if (!ctx.hasUI) return;
				const action = await ctx.ui.select("Worker pool", ["Reconfigure pool", "Clear pool", "Close"]);
				if (action === "Clear pool") {
					await writeWorkerModels(manager.rootDir, []);
					ctx.ui.notify("Worker pool cleared; subagents use the main-session model", "info");
					return;
				}
				if (action !== "Reconfigure pool") return;
			} else if (!ctx.hasUI) {
				ctx.ui.notify("No worker pool configured. Configure it in an interactive session with /swarm.", "info");
				return;
			}
			const candidates = workerModelCandidates(ctx);
			if (candidates.length === 0) {
				ctx.ui.notify("No models available for the worker pool", "warning");
				return;
			}
			const selected = await selectWorkerPool(ctx, candidates, existing);
			if (selected === undefined) return;
			await writeWorkerModels(manager.rootDir, selected);
			if (selected.length === 0) {
				ctx.ui.notify("Worker pool cleared; subagents use the main-session model", "info");
				return;
			}
			ctx.ui.notify(`Worker pool saved: ${formatPoolSummary(selected)}`, "info");
			if (existing.length === 0) {
				// First pool configuration: establish coordinator behavior for the
				// session. A custom-role message (not a user message) keeps the rules
				// in model context for every subsequent turn without triggering a
				// turn or being mistaken for a user execution request.
				pi.sendMessage(
					{
						customType: "pi-subagent-guidance",
						content: COORDINATOR_GUIDANCE,
						display: false,
					},
					{ deliverAs: "nextTurn" },
				);
			}
		},
	});
}
