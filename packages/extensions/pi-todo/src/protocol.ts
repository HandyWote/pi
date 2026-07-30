import type { EventBus } from "@handy_wote/pi-coding-agent";
import type { TodoRuntime } from "./runtime.ts";
import { TodoValidationError } from "./scheduler.ts";
import type { AgentLifecycleEvent, TodoAgentMetadata } from "./types.ts";

export const AGENT_LIFECYCLE_CHANNEL = "pi:agent:lifecycle";

export function registerAgentLifecycleProtocol(events: EventBus, runtime: TodoRuntime): () => void {
	const seen = new Set<string>();
	return events.on(AGENT_LIFECYCLE_CHANNEL, async (data) => {
		const event = parseLifecycleEvent(data);
		if (!event || seen.has(event.eventId)) return;
		seen.add(event.eventId);
		const metadata = parseTodoMetadata(event.metadata);
		if (!metadata || metadata["pi.todo/list-id"] !== runtime.getListId()) return;
		try {
			if (event.status === "queued" || event.status === "started" || event.status === "running") {
				await runtime.confirmOwnerLive(metadata["pi.todo/task-id"], event.agentId, metadata["pi.todo/claim-token"]);
			} else if (event.status === "completed") {
				await runtime.syncCurrent();
			} else if (event.status === "failed" || event.status === "stopped" || event.status === "interrupted") {
				await runtime.release(metadata["pi.todo/task-id"], event.agentId, metadata["pi.todo/claim-token"]);
			}
		} catch (error) {
			if (!(error instanceof TodoValidationError)) throw error;
		}
	});
}

function parseLifecycleEvent(value: unknown): AgentLifecycleEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.eventId !== "string" ||
		typeof record.agentId !== "string" ||
		typeof record.parentSessionId !== "string" ||
		typeof record.timestamp !== "string" ||
		typeof record.metadata !== "object" ||
		record.metadata === null ||
		!isLifecycleStatus(record.status)
	) {
		return undefined;
	}
	return record as unknown as AgentLifecycleEvent;
}

function parseTodoMetadata(metadata: Record<string, unknown>): TodoAgentMetadata | undefined {
	const listId = metadata["pi.todo/list-id"];
	const taskId = metadata["pi.todo/task-id"];
	const claimToken = metadata["pi.todo/claim-token"];
	if (typeof listId !== "string" || typeof taskId !== "string" || typeof claimToken !== "string") return undefined;
	return {
		"pi.todo/list-id": listId,
		"pi.todo/task-id": taskId,
		"pi.todo/claim-token": claimToken,
	};
}

function isLifecycleStatus(value: unknown): value is AgentLifecycleEvent["status"] {
	return ["queued", "started", "running", "completed", "failed", "stopped", "interrupted"].includes(String(value));
}
