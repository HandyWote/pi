import type { EventBus } from "@handy_wote/pi-coding-agent";
import type { TodoRuntime } from "./runtime.ts";
import { TodoValidationError } from "./scheduler.ts";
import type { AgentLifecycleEvent, TodoAgentMetadata } from "./types.ts";

export const AGENT_LIFECYCLE_CHANNEL = "pi:agent:lifecycle";
const PROTOCOL_STATE_LIMIT = 2000;

export function registerAgentLifecycleProtocol(events: EventBus, runtime: TodoRuntime): () => void {
	const seen = new Set<string>();
	const terminalClaims = new Set<string>();
	const operations = new Map<string, Promise<void>>();
	return events.on(AGENT_LIFECYCLE_CHANNEL, async (data) => {
		const event = parseLifecycleEvent(data);
		if (!event) return;
		const metadata = parseTodoMetadata(event.metadata);
		if (!metadata || metadata["pi.todo/list-id"] !== runtime.getListId()) return;
		const claimKey = `${metadata["pi.todo/list-id"]}\0${metadata["pi.todo/task-id"]}\0${metadata["pi.todo/claim-token"]}`;
		const previous = operations.get(claimKey) ?? Promise.resolve();
		const operation = previous
			.catch(() => {})
			.then(async () => {
				if (seen.has(event.eventId)) return;
				try {
					if (isActiveStatus(event.status)) {
						if (!terminalClaims.has(claimKey)) {
							await runtime.confirmOwnerLive(
								metadata["pi.todo/task-id"],
								event.agentId,
								metadata["pi.todo/claim-token"],
							);
						}
					} else if (terminalClaims.has(claimKey)) {
						// A terminal event for this exact claim already won.
					} else if (event.status === "completed") {
						const task = await runtime.getTask(metadata["pi.todo/task-id"]);
						if (task?.status !== "completed") {
							throw new TodoValidationError(`Todo "${metadata["pi.todo/task-id"]}" is not completed`);
						}
						await runtime.syncCurrent();
						remember(terminalClaims, claimKey);
					} else {
						await runtime.releaseClaim(metadata["pi.todo/task-id"], metadata["pi.todo/claim-token"]);
						remember(terminalClaims, claimKey);
					}
					remember(seen, event.eventId);
				} catch (error) {
					if (!(error instanceof TodoValidationError)) throw error;
				}
			});
		operations.set(claimKey, operation);
		try {
			await operation;
		} finally {
			if (operations.get(claimKey) === operation) operations.delete(claimKey);
		}
	});
}

function remember(values: Set<string>, value: string): void {
	values.add(value);
	if (values.size > PROTOCOL_STATE_LIMIT) values.delete(values.values().next().value ?? "");
}

function isActiveStatus(status: AgentLifecycleEvent["status"]): boolean {
	return status === "queued" || status === "started" || status === "running";
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
