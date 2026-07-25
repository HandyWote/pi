import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { TodoStore } from "./store.ts";
import type { TodoItem } from "./types.ts";

const BAR_WIDTH = 10;
const WIDGET_KEY = "pi-todo";

function renderStatus(item: TodoItem, ctx: ExtensionContext): string {
	const theme = ctx.ui.theme;
	switch (item.status) {
		case "pending":
			return theme.fg("dim", "○");
		case "running":
			return theme.fg("warning", "◐");
		case "executed":
			return theme.fg("accent", "◑");
		case "done":
			return theme.fg("success", "●");
		case "fix-needed":
			return theme.fg("warning", "!");
		case "blocked":
			return theme.fg("muted", "⊘");
		case "off-target":
		case "failed":
			return theme.fg("error", "✗");
	}
}

export function updateTodoWidget(ctx: ExtensionContext, store: TodoStore): void {
	const items = store.getItems();
	if (!ctx.hasUI || items.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const done = items.filter((item) => item.status === "done").length;
	const filled = Math.round((done / items.length) * BAR_WIDTH);
	const bar = theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
	const lines = [`${theme.bold("pi-todo")}  [${bar}] ${done}/${items.length}`];
	const visibleCount = items.length > 8 ? 7 : 8;

	for (const item of items.slice(0, visibleCount)) {
		const title = item.status === "done" ? theme.fg("muted", item.title) : theme.fg("text", item.title);
		lines.push(
			` ${renderStatus(item, ctx)}  ${theme.fg("accent", item.id)}  ${title}  ${theme.fg("dim", `wave ${item.wave}`)}`,
		);
	}
	if (items.length > visibleCount) lines.push(theme.fg("dim", ` ... ${items.length - visibleCount} more`));
	lines.push(theme.fg("dim", " ○ pending  ◐ running  ◑ review  ● done  ! fix  ⊘ blocked  ✗ failed"));
	ctx.ui.setWidget(WIDGET_KEY, lines);
}
