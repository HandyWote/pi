/**
 * EntityList dialog for extensions.
 *
 * Ports the fork's `showEntityListDialog`: a bordered EntityList with
 * activate/toggle/delete/cancel actions, searchable lists, and empty-state
 * rendering. The fork rendered it into the editor container directly; here it
 * is hosted through the public `ctx.ui.custom` API so it works from any
 * extension.
 *
 * Non-TUI modes fall back to `ctx.ui.select` (activate-only) because the RPC
 * and print UI contexts do not implement custom components.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { EntityList, type EntityListItem, type EntityListOptions } from "./entity-list.ts";
import { createEntityListTheme } from "./theme.ts";

export type EntityListDialogAction = "activate" | "toggle" | "delete";

export interface EntityListDialogResult {
	action: EntityListDialogAction;
	item: EntityListItem;
	query: string;
}

export type EntityListDialogOptions = Omit<EntityListOptions, "theme" | "title">;

/**
 * Dialog wrapper that renders the border/hints and forwards input to the
 * inner EntityList. It exposes `focused` so the TUI marks it focusable and
 * propagates focus into the list (needed for the search input cursor).
 */
class EntityListDialogComponent extends Container {
	private readonly list: EntityList;

	constructor(list: EntityList, theme: Theme, items: readonly EntityListItem[], options: EntityListDialogOptions) {
		super();
		this.list = list;
		const border = (text: string) => theme.fg("border", text);
		this.addChild(new DynamicBorder(border));
		this.addChild(new Spacer(1));
		this.addChild(list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(renderHints(theme, items, options), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(border));
	}

	get focused(): boolean {
		return this.list.focused;
	}

	set focused(value: boolean) {
		this.list.focused = value;
	}

	handleInput(data: string): boolean {
		return this.list.handleInput(data);
	}
}

function hint(theme: Theme, keybinding: Parameters<typeof keyText>[0], description: string): string {
	return `${theme.fg("dim", keyText(keybinding))}${theme.fg("muted", ` ${description}`)}`;
}

function renderHints(theme: Theme, items: readonly EntityListItem[], options: EntityListDialogOptions): string {
	const hints = [hint(theme, "tui.select.up", "navigate"), hint(theme, "tui.select.confirm", "open")];
	if (items.some((item) => item.toggleable === true || item.toggled !== undefined)) {
		hints.push(theme.fg("muted", "toggle"));
	}
	if (items.some((item) => item.deletable === true)) {
		hints.push(theme.fg("muted", "delete"));
	}
	if (options.searchable) {
		hints.push(theme.fg("muted", "search"));
	}
	hints.push(hint(theme, "tui.select.cancel", "cancel"));
	return hints.join(theme.fg("muted", " · "));
}

/**
 * Show a titled entity list and resolve with the user's action.
 * Resolves `undefined` when the user cancels.
 */
export function showEntityListDialog(
	ctx: ExtensionCommandContext,
	title: string,
	items: EntityListItem[],
	options: EntityListDialogOptions = {},
): Promise<EntityListDialogResult | undefined> {
	if (ctx.mode !== "tui") return showNonTuiDialog(ctx, title, items);

	return ctx.ui.custom<EntityListDialogResult | undefined>((_tui, theme, _keybindings, done) => {
		let closed = false;
		const finish = (result: EntityListDialogResult | undefined) => {
			if (closed) return;
			closed = true;
			done(result);
		};

		const list = new EntityList(items, { ...options, title, theme: createEntityListTheme(theme) });
		list.onActivate = (item) => finish({ action: "activate", item, query: list.getQuery() });
		list.onToggle = (item) => finish({ action: "toggle", item, query: list.getQuery() });
		list.onDelete = (item) => finish({ action: "delete", item, query: list.getQuery() });
		list.onCancel = () => finish(undefined);

		return new EntityListDialogComponent(list, theme, items, options);
	});
}

async function showNonTuiDialog(
	ctx: ExtensionCommandContext,
	title: string,
	items: readonly EntityListItem[],
): Promise<EntityListDialogResult | undefined> {
	const labels = items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label));
	const selection = await ctx.ui.select(title, labels);
	if (selection === undefined) return undefined;
	const index = labels.indexOf(selection);
	const item = index >= 0 ? items[index] : undefined;
	return item ? { action: "activate", item, query: "" } : undefined;
}
