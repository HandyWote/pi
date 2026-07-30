import type { ExtensionContext, ExtensionWidgetOptions, Theme } from "@handy_wote/pi-coding-agent";
import type { Component } from "@handy_wote/pi-tui";
import { truncateToWidth } from "@handy_wote/pi-tui";
import type { TodoListView, TodoTask } from "./types.ts";

const BAR_WIDTH = 10;
const WIDGET_KEY = "pi-todo";
const WIDGET_OPTIONS = { placement: "aboveStatus" } as unknown as ExtensionWidgetOptions;

export class TodoWidget implements Component {
	private readonly view: TodoListView;
	private readonly theme: Theme;

	constructor(view: TodoListView, theme: Theme) {
		this.view = view;
		this.theme = theme;
	}

	render(width: number): string[] {
		return renderTodoLines(this.view, this.theme, width);
	}

	invalidate(): void {}
}

export function renderTodoLines(view: TodoListView, theme: Theme, width: number): string[] {
	const { summary } = view;
	const filled = summary.total === 0 ? 0 : Math.round((summary.completed / summary.total) * BAR_WIDTH);
	const bar = theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
	const lines = [truncateToWidth(`${theme.bold("pi-todo")} [${bar}] ${summary.completed}/${summary.total}`, width)];
	appendSection(
		lines,
		"Active",
		view.list.tasks.filter((task) => task.status === "in_progress"),
		theme,
		width,
	);
	appendSection(lines, "Ready", view.ready, theme, width);
	appendSection(lines, "Blocked", view.blocked, theme, width);
	const hidden = summary.total - summary.in_progress - summary.ready - summary.blocked;
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", ` Completed ${hidden}`), width));
	return lines.slice(0, 10);
}

export function updateTodoWidget(ctx: ExtensionContext, view: TodoListView | undefined): void {
	if (!ctx.hasUI || !view || view.summary.total === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new TodoWidget(view, theme), WIDGET_OPTIONS);
}

function appendSection(lines: string[], label: string, tasks: readonly TodoTask[], theme: Theme, width: number): void {
	if (tasks.length === 0) return;
	lines.push(truncateToWidth(theme.fg("dim", ` ${label} (${tasks.length})`), width));
	for (const task of tasks.slice(0, 3)) {
		const owner = task.owner ? ` @${task.owner}` : "";
		const dependencies = label === "Blocked" ? ` <- ${task.depends_on.join(",")}` : "";
		const symbol = label === "Active" ? "◐" : label === "Blocked" ? "⊘" : "○";
		const subject = label === "Active" ? (task.active_form ?? task.subject) : task.subject;
		lines.push(
			truncateToWidth(`  ${symbol} ${theme.fg("accent", task.id)} ${subject}${owner}${dependencies}`, width),
		);
	}
}
