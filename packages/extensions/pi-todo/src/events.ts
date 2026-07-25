import type { EventBus } from "@handy_wote/pi-coding-agent";
import type { TodoStore } from "./store.ts";
import type { SubagentEvent } from "./types.ts";

const TODO_AGENT_DESCRIPTION = /^pi-todo:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

export function parseTodoAgentDescription(description: string): string | undefined {
	return TODO_AGENT_DESCRIPTION.exec(description)?.[1];
}

function parseSubagentEvent(data: unknown): SubagentEvent | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.description !== "string") return undefined;
	return {
		id: record.id,
		description: record.description,
		error: typeof record.error === "string" ? record.error : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
	};
}

export function registerSubagentEvents(events: EventBus, store: TodoStore, onChange: () => void): () => void {
	const created = events.on("subagents:created", (data) => {
		const event = parseSubagentEvent(data);
		if (!event) return;
		const taskId = parseTodoAgentDescription(event.description);
		if (taskId && store.bindAgent(taskId, event.id)) onChange();
	});

	const completed = events.on("subagents:completed", (data) => {
		const event = parseSubagentEvent(data);
		if (!event) return;
		const taskId = parseTodoAgentDescription(event.description);
		if (taskId) store.bindAgent(taskId, event.id);
		if (store.settleAgent(event.id, true)) onChange();
	});

	const failed = events.on("subagents:failed", (data) => {
		const event = parseSubagentEvent(data);
		if (!event) return;
		const taskId = parseTodoAgentDescription(event.description);
		if (taskId) store.bindAgent(taskId, event.id);
		if (store.settleAgent(event.id, false, event.error || event.status)) onChange();
	});

	return () => {
		created();
		completed();
		failed();
	};
}
