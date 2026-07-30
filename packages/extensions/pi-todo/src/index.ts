import type { ExtensionAPI } from "@handy_wote/pi-coding-agent";
import { registerTodoAutoTrigger } from "./auto.ts";
import { registerTodoCommand } from "./command.ts";
import { registerAgentLifecycleProtocol } from "./protocol.ts";
import { TodoRuntime, type TodoRuntimeOptions } from "./runtime.ts";
import { registerTodoTools } from "./tools.ts";

const PERIODIC_REMINDER_TURNS = 10;

export default function piTodo(pi: ExtensionAPI, options: TodoRuntimeOptions = {}): void {
	const runtime = new TodoRuntime(pi, options);
	let turnsSinceReminder = 0;

	registerTodoCommand(pi, runtime);
	registerTodoTools(pi, runtime);
	registerTodoAutoTrigger(pi, runtime);
	const disposeProtocol = registerAgentLifecycleProtocol(pi.events, runtime);

	pi.on("session_start", async (event, ctx) => {
		try {
			await runtime.initialize(event, ctx);
			if (event.reason === "reload" || event.reason === "resume" || event.reason === "fork") {
				await runtime.injectDigest();
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			await runtime.restoreTree(ctx);
			await runtime.injectDigest();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_compact", async () => {
		await runtime.injectDigest();
	});

	pi.on("turn_end", async () => {
		turnsSinceReminder++;
		if (turnsSinceReminder < PERIODIC_REMINDER_TURNS) return;
		turnsSinceReminder = 0;
		await runtime.injectDigest("followUp");
	});

	pi.on("session_shutdown", () => {
		disposeProtocol();
	});
}

export { TodoRuntime } from "./runtime.ts";
export { FileTodoStore, TodoPersistenceError } from "./store.ts";
export type { TodoDefinition, TodoListDocument, TodoListView, TodoStatus, TodoTask } from "./types.ts";
