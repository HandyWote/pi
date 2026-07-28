import type { ExtensionAPI, ExtensionContext } from "@handy_wote/pi-coding-agent";
import { registerTodoAutoTrigger } from "./auto.ts";
import { registerTodoCommand } from "./command.ts";
import { registerSubagentEvents } from "./events.ts";
import { TodoStore } from "./store.ts";
import { registerTodoTools } from "./tools.ts";
import { updateTodoWidget } from "./widget.ts";

export default function piTodo(pi: ExtensionAPI): void {
	const store = new TodoStore();
	let currentContext: ExtensionContext | undefined;

	registerTodoCommand(pi);
	registerTodoTools(pi, store);
	registerTodoAutoTrigger(pi, store);
	const disposeEvents = registerSubagentEvents(pi.events, store, () => {
		if (currentContext) updateTodoWidget(currentContext, store);
	});

	pi.on("session_start", (_event, ctx) => {
		store.clear();
		currentContext = ctx;
		updateTodoWidget(ctx, store);
	});

	pi.on("session_shutdown", () => {
		disposeEvents();
		currentContext = undefined;
	});
}
