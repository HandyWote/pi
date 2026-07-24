import type { Model } from "@handy_wote/pi-ai";
import { Container, EntityList, type Focusable, getKeybindings, Spacer, Text } from "@handy_wote/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";
import { keyText } from "./keybinding-hints.ts";

type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

function toggle(enabledIds: EnabledIds, id: string): EnabledIds {
	if (enabledIds === null) return [id];
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return [...enabledIds, id];
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null;
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length ? null : result;
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const index = enabledIds.indexOf(id);
	if (index < 0) return enabledIds;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= enabledIds.length) return enabledIds;
	const result = [...enabledIds];
	[result[index], result[newIndex]] = [result[newIndex]!, result[index]!];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

export interface ModelsConfig {
	allModels: Model<any>[];
	enabledModelIds: string[] | null;
	profileNames?: ReadonlyMap<string, string>;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

/** Component for enabling/disabling models for Ctrl+P cycling. */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private readonly modelsById = new Map<string, Model<any>>();
	private readonly allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private readonly list: EntityList;
	private readonly footerText: Text;
	private readonly detailsText: Text;
	private readonly callbacks: ModelsCallbacks;
	private readonly profileNames: ReadonlyMap<string, string>;
	private isDirty = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.list.focused = value;
	}

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;
		this.profileNames = config.profileNames ?? new Map();
		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		this.list = new EntityList([], {
			theme: getEntityListTheme(),
			maxVisible: 8,
			searchable: true,
			getSearchText: (item) => {
				const model = this.modelsById.get(item.id);
				return model ? `${model.provider} ${model.id} ${model.name}` : item.label;
			},
		});
		this.list.onToggle = (item) => this.toggleModel(item.id);
		this.list.onCancel = callbacks.onCancel;
		this.list.onSelectionChange = () => this.updateDetails();
		this.list.onSearchChange = () => this.updateDetails();
		this.addChild(this.list);

		this.detailsText = new Text("", 0, 0);
		this.addChild(this.detailsText);
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder());
		this.refresh();
	}

	private buildItems() {
		return getSortedIds(this.enabledIds, this.allIds)
			.filter((id) => this.modelsById.has(id))
			.map((id) => {
				const model = this.modelsById.get(id)!;
				return {
					id,
					label: model.id,
					description: `[${this.profileNames.get(model.provider) ?? model.provider}] ${id}`,
					toggled: isEnabled(this.enabledIds, id),
					toggleable: true,
				};
			});
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.length ?? this.allIds.length;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled ? "all enabled" : `${enabledCount}/${this.allIds.length} enabled`;
		const parts = [
			`${keyText("tui.entity.toggle")} toggle`,
			`${keyText("tui.entity.search")} search`,
			`${keyText("app.models.enableAll")} all`,
			`${keyText("app.models.clearAll")} clear`,
			`${keyText("app.models.toggleProvider")} provider`,
			`${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")} reorder`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		this.list.setItems(this.buildItems());
		this.footerText.setText(this.getFooterText());
		this.updateDetails();
	}

	private updateDetails(): void {
		const selectedId = this.list.getSelectedItem()?.id;
		const model = selectedId ? this.modelsById.get(selectedId) : undefined;
		this.detailsText.setText(
			model
				? theme.fg(
						"muted",
						`\n  Profile: ${this.profileNames.get(model.provider) ?? model.provider}\n  Reference: ${selectedId}\n  Model Name: ${model.name}`,
					)
				: "",
		);
	}

	private notifyChange(): void {
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private toggleModel(id: string): void {
		this.enabledIds = toggle(this.enabledIds, id);
		this.isDirty = true;
		this.refresh();
		this.notifyChange();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.list.isSearching()) {
			this.list.handleInput(data);
			this.updateDetails();
			return;
		}

		const selectedId = this.list.getSelectedItem()?.id;
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (selectedId && (reorderUp || reorderDown)) {
			if (this.enabledIds !== null && isEnabled(this.enabledIds, selectedId)) {
				const delta = reorderUp ? -1 : 1;
				const next = move(this.enabledIds, selectedId, delta);
				if (next !== this.enabledIds) {
					this.enabledIds = next;
					this.isDirty = true;
					this.refresh();
					this.notifyChange();
				}
			}
			return;
		}

		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.list.getQuery() ? this.list.getFilteredItems().map((item) => item.id) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.list.getQuery() ? this.list.getFilteredItems().map((item) => item.id) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}
		if (kb.matches(data, "app.models.toggleProvider")) {
			const model = selectedId ? this.modelsById.get(selectedId) : undefined;
			if (model) {
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === model.provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}
		if (kb.matches(data, "app.models.save")) {
			this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		this.list.handleInput(data);
		this.updateDetails();
	}
}
