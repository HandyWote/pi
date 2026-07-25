import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@handy_wote/pi-coding-agent";

const EMPTY_PLAN_ERROR = "请提供 md 路径或 inline 计划文本";

export function registerTodoCommand(pi: ExtensionAPI): void {
	pi.registerCommand("todo", {
		description: "Load a Markdown or inline plan into pi-todo",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(EMPTY_PLAN_ERROR, "error");
				return;
			}

			const candidate = resolve(ctx.cwd, input);
			let plan = input;
			let source = "inline plan";
			try {
				const file = await stat(candidate);
				if (file.isFile()) {
					if (extname(candidate).toLowerCase() !== ".md") {
						ctx.ui.notify("Todo plan files must use the .md extension", "error");
						return;
					}
					plan = await readFile(candidate, "utf8");
					source = candidate;
				}
			} catch (error) {
				if (extname(input).toLowerCase() === ".md") {
					ctx.ui.notify(error instanceof Error ? error.message : `Unable to read ${candidate}`, "error");
					return;
				}
			}

			pi.sendMessage(
				{
					customType: "pi-todo-plan",
					content: `[PI TODO PLAN]\nSource: ${source}\n\n${plan}\n\nConvert this plan into a dependency-aware todo graph by calling write_todo. Preserve the plan's intent in global_direction and give every task concrete acceptance criteria. Then call next_wave and execute the returned work.`,
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});
}
