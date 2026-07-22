import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { Input } from "./input.ts";

export interface EntityListItem {
	id: string;
	label: string;
	description?: string;
	toggled?: boolean;
	toggleable?: boolean;
	deletable?: boolean;
}

export interface EntityListTheme {
	title: (text: string) => string;
	cursor: (text: string) => string;
	selected: (text: string) => string;
	label: (text: string) => string;
	description: (text: string) => string;
	toggled: (text: string) => string;
	untoggled: (text: string) => string;
	hint: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	deletePending: (text: string) => string;
}

export interface EntityListRenderContext {
	item: EntityListItem;
	selected: boolean;
	confirmingDelete: boolean;
	width: number;
}

export interface EntityListOptions {
	title?: string;
	maxVisible?: number;
	wrap?: boolean;
	searchable?: boolean;
	theme: EntityListTheme;
	initialSelectedId?: string;
	initialQuery?: string;
	renderToggle?: (item: EntityListItem, selected: boolean) => string;
	renderItem?: (context: EntityListRenderContext) => string | string[];
	renderEmpty?: (width: number, query: string) => string[];
	getSearchText?: (item: EntityListItem) => string;
	filterItems?: (items: readonly EntityListItem[], query: string) => EntityListItem[];
}

export class EntityList implements Component, Focusable {
	private items: EntityListItem[];
	private filteredItems: EntityListItem[] = [];
	private selectedIndex = 0;
	private confirmingDeleteId: string | undefined;
	private searching = false;
	private readonly searchInput = new Input();
	private readonly options: EntityListOptions;
	private _focused = false;

	public onActivate?: (item: EntityListItem) => void;
	public onToggle?: (item: EntityListItem) => void;
	public onDelete?: (item: EntityListItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: EntityListItem) => void;
	public onSearchChange?: (query: string) => void;
	public onDeleteConfirmationChange?: (item: EntityListItem | undefined) => void;

	constructor(items: EntityListItem[], options: EntityListOptions) {
		this.items = [...items];
		this.options = options;
		if (options.initialQuery) {
			this.searchInput.setValue(options.initialQuery);
			this.searching = true;
		}
		this.applyFilter(options.initialSelectedId);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.searching;
	}

	setItems(items: EntityListItem[]): void {
		const selectedId = this.getSelectedItem()?.id;
		const previousIndex = this.selectedIndex;
		this.items = [...items];
		this.applyFilter(selectedId, previousIndex);
		if (this.confirmingDeleteId && !this.items.some((item) => item.id === this.confirmingDeleteId)) {
			this.setConfirmingDelete(undefined);
		}
	}

	refreshFilter(): void {
		this.applyFilter(this.getSelectedItem()?.id, this.selectedIndex);
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = this.clampIndex(index);
	}

	setSelectedId(id: string): void {
		const index = this.filteredItems.findIndex((item) => item.id === id);
		if (index >= 0) this.selectedIndex = index;
	}

	getSelectedItem(): EntityListItem | null {
		return this.filteredItems[this.selectedIndex] ?? null;
	}

	getFilteredItems(): readonly EntityListItem[] {
		return this.filteredItems;
	}

	getQuery(): string {
		return this.searchInput.getValue();
	}

	setQuery(query: string, searching = query.length > 0): void {
		this.searchInput.setValue(query);
		this.searching = searching;
		this.searchInput.focused = this._focused && this.searching;
		this.applyFilter();
		this.onSearchChange?.(query);
	}

	isSearching(): boolean {
		return this.searching;
	}

	isConfirmingDelete(): boolean {
		return this.confirmingDeleteId !== undefined;
	}

	requestDeleteSelected(): boolean {
		const item = this.getSelectedItem();
		if (!item || item.deletable !== true) return false;
		if (this.confirmingDeleteId === item.id) {
			this.setConfirmingDelete(undefined);
			this.onDelete?.(item);
		} else {
			this.setConfirmingDelete(item.id);
		}
		return true;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const theme = this.options.theme;
		if (this.options.title) lines.push(theme.title(this.options.title));
		if (this.searching) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.filteredItems.length === 0) {
			const emptyLines = this.options.renderEmpty?.(width, this.getQuery()) ?? [
				theme.noMatch("  No matching items"),
			];
			lines.push(...emptyLines);
			return lines;
		}

		const maxVisible = Math.max(1, this.options.maxVisible ?? 10);
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

		for (let index = startIndex; index < endIndex; index++) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const confirmingDelete = item.id === this.confirmingDeleteId;
			const rendered = this.options.renderItem?.({ item, selected, confirmingDelete, width });
			if (rendered !== undefined) {
				lines.push(...(Array.isArray(rendered) ? rendered : [rendered]));
			} else {
				lines.push(this.renderDefaultItem(item, selected, width));
			}
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			lines.push(theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`));
		}
		if (this.confirmingDeleteId) {
			const deleteKeys = getKeybindings().getKeys("tui.entity.delete").join("/");
			lines.push(theme.deletePending(`  Press ${deleteKeys} again to confirm delete; any other key cancels`));
		}
		return lines;
	}

	handleInput(data: string): boolean {
		const kb = getKeybindings();

		if (this.searching) {
			if (kb.matches(data, "tui.entity.searchExit")) {
				this.searching = false;
				this.searchInput.focused = false;
				this.searchInput.setValue("");
				this.applyFilter();
				this.onSearchChange?.("");
				return true;
			}
			if (kb.matches(data, "tui.entity.cancel")) {
				this.onCancel?.();
				return true;
			}
			if (kb.matches(data, "tui.select.up")) {
				this.moveSelection(-1);
				return true;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.moveSelection(1);
				return true;
			}
			if (kb.matches(data, "tui.select.pageUp")) {
				this.moveSelection(-(this.options.maxVisible ?? 10));
				return true;
			}
			if (kb.matches(data, "tui.select.pageDown")) {
				this.moveSelection(this.options.maxVisible ?? 10);
				return true;
			}
			if (kb.matches(data, "tui.entity.activate")) {
				const selected = this.getSelectedItem();
				if (selected) this.onActivate?.(selected);
				return true;
			}

			const previousQuery = this.getQuery();
			this.searchInput.handleInput(data);
			const query = this.getQuery();
			if (query !== previousQuery) {
				this.applyFilter();
				this.onSearchChange?.(query);
			}
			return true;
		}

		if (this.confirmingDeleteId && !kb.matches(data, "tui.entity.delete")) {
			this.setConfirmingDelete(undefined);
		}

		if (this.options.searchable && kb.matches(data, "tui.entity.search")) {
			this.searching = true;
			this.searchInput.focused = this._focused;
			return true;
		}
		if (kb.matches(data, "tui.entity.up")) {
			this.moveSelection(-1);
			return true;
		}
		if (kb.matches(data, "tui.entity.down")) {
			this.moveSelection(1);
			return true;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-(this.options.maxVisible ?? 10));
			return true;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(this.options.maxVisible ?? 10);
			return true;
		}
		if (kb.matches(data, "tui.entity.activate")) {
			const selected = this.getSelectedItem();
			if (selected) this.onActivate?.(selected);
			return true;
		}
		if (kb.matches(data, "tui.entity.toggle")) {
			const selected = this.getSelectedItem();
			if (selected && (selected.toggleable === true || selected.toggled !== undefined)) {
				this.onToggle?.(selected);
			}
			return true;
		}
		if (kb.matches(data, "tui.entity.delete")) {
			this.requestDeleteSelected();
			return true;
		}
		if (kb.matches(data, "tui.entity.cancel")) {
			this.onCancel?.();
			return true;
		}
		return false;
	}

	private applyFilter(selectedId?: string, fallbackIndex = 0): void {
		const query = this.getQuery();
		if (this.options.filterItems) {
			this.filteredItems = this.options.filterItems(this.items, query);
		} else if (query) {
			this.filteredItems = fuzzyFilter(
				this.items,
				query,
				this.options.getSearchText ?? ((item) => `${item.id} ${item.label} ${item.description ?? ""}`),
			);
		} else {
			this.filteredItems = [...this.items];
		}
		const preservedIndex = selectedId ? this.filteredItems.findIndex((item) => item.id === selectedId) : -1;
		this.selectedIndex = preservedIndex >= 0 ? preservedIndex : this.clampIndex(fallbackIndex);
	}

	private clampIndex(index: number): number {
		return Math.max(0, Math.min(index, Math.max(0, this.filteredItems.length - 1)));
	}

	private moveSelection(delta: number): void {
		if (this.filteredItems.length === 0) return;
		let next = this.selectedIndex + delta;
		if (this.options.wrap) {
			next = ((next % this.filteredItems.length) + this.filteredItems.length) % this.filteredItems.length;
		} else {
			next = this.clampIndex(next);
		}
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		const selected = this.getSelectedItem();
		if (selected) this.onSelectionChange?.(selected);
	}

	private setConfirmingDelete(id: string | undefined): void {
		this.confirmingDeleteId = id;
		const item = id ? this.items.find((candidate) => candidate.id === id) : undefined;
		this.onDeleteConfirmationChange?.(item);
	}

	private renderDefaultItem(item: EntityListItem, selected: boolean, width: number): string {
		const theme = this.options.theme;
		const cursor = selected ? theme.cursor("→ ") : "  ";
		const toggleable = item.toggleable === true || item.toggled !== undefined;
		const toggle = toggleable
			? (this.options.renderToggle?.(item, selected) ??
				(item.toggled ? theme.toggled("[x] ") : theme.untoggled("[ ] ")))
			: "";
		const prefixWidth = visibleWidth(cursor) + visibleWidth(toggle);
		const labelText = selected ? theme.selected(item.label) : theme.label(item.label);
		if (!item.description) {
			return cursor + toggle + truncateToWidth(labelText, Math.max(1, width - prefixWidth), "");
		}

		const description = theme.description(item.description.replace(/[\r\n]+/g, " ").trim());
		const available = Math.max(1, width - prefixWidth);
		const descriptionWidth = Math.min(visibleWidth(description), Math.max(0, Math.floor(available / 2)));
		if (descriptionWidth < 4) {
			return cursor + toggle + truncateToWidth(labelText, available, "");
		}
		const labelWidth = Math.max(1, available - descriptionWidth - 2);
		const label = truncateToWidth(labelText, labelWidth, "");
		const spacing = " ".repeat(Math.max(2, available - visibleWidth(label) - descriptionWidth));
		return cursor + toggle + label + spacing + truncateToWidth(description, descriptionWidth, "");
	}
}
