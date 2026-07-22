import { type Model, modelsAreEqual } from "@handy_wote/pi-ai";
import { Container, EntityList, type Focusable, getKeybindings, Spacer, Text, type TUI } from "@handy_wote/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { getEntityListTheme } from "./entity-list-theme.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "scoped";

/** Component that renders a model selector with explicit search mode. */
export class ModelSelectorComponent extends Container implements Focusable {
	private readonly list: EntityList;
	private readonly detailsContainer = new Container();
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private currentModel?: Model<any>;
	private readonly settingsManager: SettingsManager;
	private readonly modelRuntime: ModelRuntime;
	private readonly onSelectCallback: (model: Model<any>) => void;
	private readonly onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private readonly tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.list.focused = value;
	}

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();
		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			this.addChild(
				new Text(
					theme.fg("warning", "Only showing models from configured providers. Use /profile to manage profiles."),
					0,
					0,
				),
			);
		}
		this.addChild(new Spacer(1));

		this.list = new EntityList([], {
			theme: getEntityListTheme(),
			maxVisible: 10,
			searchable: true,
			initialQuery: initialSearchInput,
			getSearchText: (item) => {
				const modelItem = this.activeModels.find((candidate) => this.getItemId(candidate) === item.id);
				return modelItem
					? getModelSelectorSearchText({
							id: modelItem.id,
							provider: modelItem.provider,
							name: modelItem.model.name,
						})
					: item.label;
			},
		});
		this.list.onActivate = (item) => {
			const selected = this.activeModels.find((candidate) => this.getItemId(candidate) === item.id);
			if (selected) this.handleSelect(selected.model);
		};
		this.list.onCancel = () => {
			this.close();
			this.onCancelCallback();
		};
		this.list.onSelectionChange = () => this.updateDetails();
		this.list.onSearchChange = () => this.updateDetails();
		this.addChild(this.list);
		this.addChild(this.detailsContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.loadModelsFromSnapshot();
		this.updateDetails();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private getItemId(item: ModelItem): string {
		return `${item.provider}/${item.id}`;
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.syncList();
		if (this.currentModel) this.list.setSelectedId(`${this.currentModel.provider}/${this.currentModel.id}`);
	}

	private syncList(): void {
		this.list.setItems(
			this.activeModels.map((item) => ({
				id: this.getItemId(item),
				label: item.id,
				description: `[${item.provider}]${modelsAreEqual(this.currentModel, item.model) ? " ✓" : ""}`,
			})),
		);
		this.updateDetails();
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await this.modelRuntime.refresh({ signal: this.refreshAbortController.signal });
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs; showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	private close(): void {
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		return [...models].sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return (
			keyHint("tui.input.tab", "scope") +
			theme.fg("muted", " (all/scoped) · ") +
			keyHint("tui.entity.search", "search")
		);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.syncList();
		if (this.currentModel) this.list.setSelectedId(`${this.currentModel.provider}/${this.currentModel.id}`);
		this.scopeText?.setText(this.getScopeText());
	}

	private updateDetails(): void {
		this.detailsContainer.clear();
		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				this.detailsContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else {
			const selectedId = this.list.getSelectedItem()?.id;
			const selected = this.activeModels.find((item) => this.getItemId(item) === selectedId);
			if (selected) {
				this.detailsContainer.addChild(new Spacer(1));
				this.detailsContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
			}
		}
		if (this.refreshStatusMessage) {
			this.detailsContainer.addChild(new Spacer(1));
			this.detailsContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (!this.list.isSearching() && kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
				this.scopeHintText?.setText(this.getScopeHintText());
			}
			return;
		}
		this.list.handleInput(keyData);
		this.updateDetails();
	}

	private handleSelect(model: Model<any>): void {
		this.close();
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}
}
