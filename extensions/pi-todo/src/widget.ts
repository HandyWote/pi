import type { ExtensionContext, ExtensionWidgetOptions, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoListView, TodoTask } from "./types.ts";

const MAX_LINES = 10;
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
	const lines = [truncateToWidth(`${theme.bold("pi-todo")} ${summary.completed}/${summary.total}`, width)];
	const active = view.list.tasks.filter((task) => task.status === "in_progress");
	const completed = view.list.tasks.filter((task) => task.status === "completed");
	const taskLines = [
		...active.map((task) => formatTaskLine(theme, task, "[*]", width, { active: true })),
		...view.ready.map((task) => formatTaskLine(theme, task, "[ ]", width, {})),
		...view.blocked.map((task) => formatTaskLine(theme, task, "[ ]", width, { blocked: true })),
		...completed.map((task) => formatTaskLine(theme, task, "[x]", width, { done: true })),
	];
	const budget = MAX_LINES - 1;
	const overflow = taskLines.length > budget ? taskLines.length - budget : 0;
	for (const line of taskLines.slice(0, budget)) lines.push(line);
	if (overflow > 0) lines.push(truncateToWidth(theme.fg("dim", ` ... ${overflow} more`), width));
	return lines;
}

export function updateTodoWidget(ctx: ExtensionContext, view: TodoListView | undefined): void {
	if (!ctx.hasUI || !view || view.summary.total === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new TodoWidget(view, theme), WIDGET_OPTIONS);
}

interface TaskLineOptions {
	active?: boolean;
	blocked?: boolean;
	done?: boolean;
}

function formatTaskLine(theme: Theme, task: TodoTask, check: string, width: number, options: TaskLineOptions): string {
	const symbol = theme.fg(options.done ? "success" : options.active ? "accent" : "dim", check);
	const id = theme.fg(options.done ? "muted" : "accent", task.id);
	const subject = options.active ? (task.active_form ?? task.subject) : task.subject;
	const text = options.done ? theme.strikethrough(theme.fg("dim", subject)) : subject;
	const owner = options.active && task.owner ? ` ${theme.fg("dim", `@${task.owner}`)}` : "";
	const dependencies = options.blocked ? ` ${theme.fg("dim", `<- ${task.depends_on.join(",")}`)}` : "";
	return truncateToWidth(`${symbol} ${id} ${text}${owner}${dependencies}`, width);
}
