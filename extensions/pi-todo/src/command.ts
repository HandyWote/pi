import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTodoPlanMessageContent } from "./plan-message.ts";
import type { TodoRuntime } from "./runtime.ts";
import type { TodoListView, TodoTask } from "./types.ts";

const STRIKE = "\u001b[9m";
const STRIKE_OFF = "\u001b[29m";

export function registerTodoCommand(pi: ExtensionAPI, runtime: TodoRuntime): void {
	pi.registerCommand("todo", {
		description: "List, inspect, import, delete, or clear persistent todo tasks",
		handler: async (args, ctx) => {
			await runtime.reconcileOwners();
			const input = args.trim();
			if (!input || input === "list") {
				const view = await runtime.view();
				if (!view) {
					ctx.ui.notify("No todo list is active", "info");
					return;
				}
				ctx.ui.notify(formatTodoList(view, ctx.mode === "tui"), "info");
				return;
			}

			const [action, ...rest] = input.split(/\s+/);
			if (action === "inspect") {
				const id = rest.join(" ");
				const task = await runtime.getTask(id);
				ctx.ui.notify(
					task ? JSON.stringify(task, null, 2) : `Todo "${id}" does not exist`,
					task ? "info" : "error",
				);
				return;
			}
			if (action === "delete") {
				const id = rest.join(" ");
				if (!id) {
					ctx.ui.notify("Usage: /todo delete <task-id>", "error");
					return;
				}
				if (!(await ctx.ui.confirm("Delete todo", `Delete ${id} and clean its dependency edges?`))) return;
				await runtime.delete(id);
				ctx.ui.notify(`Deleted ${id}`, "info");
				return;
			}
			if (action === "clear") {
				if (!(await ctx.ui.confirm("Clear todo list", "Delete the active task list permanently?"))) return;
				await runtime.clear();
				ctx.ui.notify("Cleared the active todo list", "info");
				return;
			}

			const planInput = action === "import" ? rest.join(" ") : input;
			if (!planInput) {
				ctx.ui.notify("Usage: /todo import <markdown-path-or-inline-plan>", "error");
				return;
			}
			const { plan, source } = await resolvePlan(planInput, ctx.cwd);
			pi.sendMessage(
				{ customType: "pi-todo-plan", content: buildTodoPlanMessageContent({ source, plan }), display: true },
				{ triggerTurn: true },
			);
		},
	});
}

function formatTodoList(view: TodoListView, ansi: boolean): string {
	const summary = view.summary;
	const summaryText = `${summary.completed}/${summary.total} completed, ${summary.in_progress} active, ${summary.ready} ready, ${summary.blocked} blocked`;
	const format = (task: TodoTask): string => {
		const check = task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[*]" : "[ ]";
		const owner = task.owner ? ` @${task.owner}` : "";
		const dependencies = task.depends_on.length ? ` <- ${task.depends_on.join(",")}` : "";
		const subject = truncate(task.subject, 300);
		const text = task.status === "completed" && ansi ? `${STRIKE}${subject}${STRIKE_OFF}` : subject;
		return `${check} ${task.id}: ${text}${owner}${dependencies}`;
	};
	const visible = view.list.tasks.slice(0, 20).map(format);
	if (view.list.tasks.length > visible.length)
		visible.push(`... ${view.list.tasks.length - visible.length} more tasks`);
	return `${summaryText}\n${visible.join("\n")}`;
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

async function resolvePlan(input: string, cwd: string): Promise<{ plan: string; source: string }> {
	const candidate = resolve(cwd, input);
	try {
		const file = await stat(candidate);
		if (!file.isFile()) return { plan: input, source: "inline plan" };
		if (extname(candidate).toLowerCase() !== ".md") throw new Error("Todo plan files must use the .md extension");
		return { plan: await readFile(candidate, "utf8"), source: candidate };
	} catch (error) {
		if (extname(input).toLowerCase() === ".md") throw error;
		return { plan: input, source: "inline plan" };
	}
}
