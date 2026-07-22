import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { EntityList, type EntityListItem, type EntityListTheme } from "../src/components/entity-list.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";

const testTheme: EntityListTheme = {
	title: (text) => text,
	cursor: (text) => text,
	selected: (text) => text,
	label: (text) => text,
	description: (text) => text,
	toggled: (text) => text,
	untoggled: (text) => text,
	hint: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
	deletePending: (text) => text,
};

const items: EntityListItem[] = [
	{ id: "a", label: "Alpha", toggleable: true, toggled: false, deletable: true },
	{ id: "b", label: "Beta", toggleable: true, toggled: true, deletable: true },
	{ id: "c", label: "Gamma", toggleable: true, toggled: false, deletable: true },
];

describe("EntityList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("moves without wrapping and supports j/k aliases", () => {
		const list = new EntityList(items, { theme: testTheme });

		list.handleInput("k");
		assert.equal(list.getSelectedItem()?.id, "a");
		list.handleInput("j");
		list.handleInput("j");
		list.handleInput("j");
		assert.equal(list.getSelectedItem()?.id, "c");
		list.handleInput("k");
		assert.equal(list.getSelectedItem()?.id, "b");
	});

	it("dispatches activate, toggle, and cancel actions", () => {
		const list = new EntityList(items, { theme: testTheme });
		const actions: string[] = [];
		list.onActivate = (item) => actions.push(`activate:${item.id}`);
		list.onToggle = (item) => actions.push(`toggle:${item.id}`);
		list.onCancel = () => actions.push("cancel");

		list.handleInput("\r");
		list.handleInput(" ");
		list.handleInput("\x1b");

		assert.deepEqual(actions, ["activate:a", "toggle:a", "cancel"]);
	});

	it("requires the delete action twice and cancels confirmation on another key", () => {
		const list = new EntityList(items, { theme: testTheme });
		const deleted: string[] = [];
		list.onDelete = (item) => deleted.push(item.id);

		list.handleInput("x");
		assert.match(list.render(80).join("\n"), /again to confirm delete/);
		list.handleInput("j");
		list.handleInput("x");
		assert.deepEqual(deleted, []);
		list.handleInput("x");
		assert.deepEqual(deleted, ["b"]);
	});

	it("treats operation keys as query text while search mode is active", () => {
		const list = new EntityList(items, { theme: testTheme, searchable: true });
		let toggles = 0;
		list.onToggle = () => toggles++;

		list.handleInput("/");
		list.handleInput("j");
		list.handleInput(" ");
		list.handleInput("x");

		assert.equal(list.getQuery(), "j x");
		assert.equal(toggles, 0);
		list.handleInput("\x1b");
		assert.equal(list.getQuery(), "");
		assert.equal(list.isSearching(), false);
	});

	it("preserves selection by id when items change", () => {
		const list = new EntityList(items, { theme: testTheme, initialSelectedId: "b" });

		list.setItems([items[2]!, items[1]!]);

		assert.equal(list.getSelectedItem()?.id, "b");
	});
});
