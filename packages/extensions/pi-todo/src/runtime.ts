import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionStartEvent } from "@handy_wote/pi-coding-agent";
import { getAgentDir } from "@handy_wote/pi-coding-agent";
import { FileTodoStore } from "./store.ts";
import type { TodoBindingEntry, TodoDefinition, TodoListDocument, TodoListView } from "./types.ts";
import { updateTodoWidget } from "./widget.ts";

export const TODO_BINDING_ENTRY = "pi-todo-binding";
export const TODO_DIGEST_MESSAGE = "pi-todo-digest";
export const AGENT_STATUS_REQUEST_CHANNEL = "pi:agent:status-request";

const OWNER_EVIDENCE_WAIT_MS = 50;
const PERIODIC_REMINDER_TURNS = 10;
const DIGEST_TASKS_PER_SECTION = 5;
const DIGEST_DIRECTION_LIMIT = 500;
const DIGEST_CHAR_LIMIT = 4000;

export interface TodoRuntimeOptions {
	dataDir?: string;
}

interface AgentContext {
	agentId?: string;
	metadata: Record<string, unknown>;
}

export class TodoRuntime {
	readonly store: FileTodoStore;
	private readonly pi: ExtensionAPI;
	private binding: TodoBindingEntry | undefined;
	private context: ExtensionContext | undefined;
	private agentContext: AgentContext | undefined;
	private readonly liveOwners = new Set<string>();
	private readonly pendingOwnerEvidence = new Set<Promise<void>>();
	private ownerReconciliationPending = false;
	private digestActive = false;
	private turnsSinceReminder = 0;

	constructor(pi: ExtensionAPI, options: TodoRuntimeOptions = {}) {
		this.pi = pi;
		this.store = new FileTodoStore(options.dataDir ?? join(getAgentDir(), "todo", "lists"));
		this.agentContext = parseAgentContext(process.env.PI_AGENT_CONTEXT);
	}

	getListId(): string | undefined {
		return this.binding?.list_id ?? undefined;
	}

	getTaskContext(): { listId: string; taskId: string; agentId?: string } | undefined {
		const metadata = this.agentContext?.metadata;
		if (!metadata) return undefined;
		const listId = metadata["pi.todo/list-id"];
		const taskId = metadata["pi.todo/task-id"];
		if (typeof listId !== "string" || typeof taskId !== "string") return undefined;
		return { listId, taskId, agentId: this.agentContext?.agentId };
	}

	async initialize(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		this.liveOwners.clear();
		this.ownerReconciliationPending = false;
		const agentTask = this.getTaskContext();
		if (agentTask) {
			if (agentTask.agentId) this.liveOwners.add(agentTask.agentId);
			const list = await this.store.read(agentTask.listId);
			this.setBinding(list, true);
			await this.refresh();
			return;
		}

		if (event.reason === "new") {
			this.cancelDigest();
			this.binding = undefined;
			this.digestActive = false;
			this.turnsSinceReminder = 0;
			updateTodoWidget(ctx, undefined);
			return;
		}

		const restored = latestBinding(ctx.sessionManager.getBranch());
		if (!restored?.list_id) {
			this.cancelDigest();
			this.binding = undefined;
			this.digestActive = false;
			this.turnsSinceReminder = 0;
			updateTodoWidget(ctx, undefined);
			return;
		}

		if (event.reason === "fork") {
			const cloned = await this.store.clone(restored.list_id, restored.revision);
			this.setBinding(cloned, true);
		} else {
			this.setBinding(await this.store.read(restored.list_id), false);
			const sessionId = ctx.sessionManager.getSessionId();
			this.liveOwners.add(sessionId);
			this.ownerReconciliationPending = true;
		}
		await this.refresh();
	}

	async restoreTree(ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		const restored = latestBinding(ctx.sessionManager.getBranch());
		if (!restored?.list_id) {
			this.cancelDigest();
			this.binding = undefined;
			this.digestActive = false;
			this.turnsSinceReminder = 0;
			updateTodoWidget(ctx, undefined);
			return;
		}
		const current = await this.store.read(restored.list_id);
		if (restored.revision < current.revision) {
			const cloned = await this.store.clone(restored.list_id, restored.revision);
			this.setBinding(cloned, true);
		} else {
			this.setBinding(current, false);
		}
		await this.refresh();
	}

	async replace(globalDirection: string, items: readonly TodoDefinition[]): Promise<TodoListDocument> {
		const document = await this.store.create(globalDirection, items);
		this.setBinding(document, true);
		await this.refresh();
		return document;
	}

	async add(items: readonly TodoDefinition[], globalDirection?: string): Promise<TodoListDocument> {
		if (!this.binding?.list_id) {
			if (!globalDirection) throw new Error("No todo list is active; provide global_direction to create one");
			return this.replace(globalDirection, items);
		}
		return this.record(await this.store.add(this.binding.list_id, items));
	}

	async update(taskId: string, patch: Parameters<FileTodoStore["update"]>[2]): Promise<TodoListDocument> {
		const document = await this.record(await this.store.update(this.requireListId(), taskId, patch));
		if (document.tasks.length > 0 && document.tasks.every((task) => task.status === "completed")) {
			await this.clear();
		}
		return document;
	}

	async claim(taskId: string, owner?: string, expectedRevision?: number) {
		const claim = await this.store.claim(
			this.requireListId(),
			taskId,
			owner ?? this.agentContext?.agentId ?? this.context?.sessionManager.getSessionId() ?? "main",
			expectedRevision,
		);
		await this.record(await this.store.read(this.requireListId()));
		return claim;
	}

	async release(taskId: string): Promise<TodoListDocument> {
		return this.record(await this.store.release(this.requireListId(), taskId));
	}

	async transfer(taskId: string, owner: string): Promise<TodoListDocument> {
		return this.record(await this.store.transfer(this.requireListId(), taskId, owner));
	}

	async confirmOwnerLive(taskId: string, owner: string): Promise<void> {
		const evidence = (async () => {
			const document = await this.store.transfer(this.requireListId(), taskId, owner);
			this.liveOwners.add(owner);
			await this.record(document);
		})();
		this.pendingOwnerEvidence.add(evidence);
		try {
			await evidence;
		} finally {
			this.pendingOwnerEvidence.delete(evidence);
		}
	}

	async syncCurrent(): Promise<TodoListDocument> {
		return this.record(await this.store.read(this.requireListId()));
	}

	async releaseIfOwned(taskId: string, owner: string): Promise<TodoListDocument> {
		return this.record(await this.store.releaseIfOwned(this.requireListId(), taskId, owner));
	}

	async reconcileOwners(): Promise<boolean> {
		if (!this.ownerReconciliationPending || this.agentContext) return false;
		const listId = this.requireListId();
		const sessionId = this.context?.sessionManager.getSessionId();
		if (!sessionId) return false;
		this.pi.events.emit(AGENT_STATUS_REQUEST_CHANNEL, {
			version: 2,
			parentSessionId: sessionId,
			timestamp: new Date().toISOString(),
		});
		await new Promise((resolve) => setTimeout(resolve, OWNER_EVIDENCE_WAIT_MS));
		await this.waitForOwnerEvidence();
		const list = await this.store.reconcileOwners(listId, this.liveOwners);
		this.setBinding(list, true);
		this.ownerReconciliationPending = false;
		await this.refresh();
		return true;
	}

	async delete(taskId: string): Promise<TodoListDocument> {
		return this.record(await this.store.delete(this.requireListId(), taskId));
	}

	async clear(): Promise<void> {
		const listId = this.binding?.list_id;
		if (listId) this.cancelDigest(listId);
		this.binding = undefined;
		this.digestActive = false;
		this.turnsSinceReminder = 0;
		this.pi.appendEntry<TodoBindingEntry>(TODO_BINDING_ENTRY, {
			version: 1,
			list_id: null,
			revision: 0,
			timestamp: new Date().toISOString(),
		});
		if (listId) await this.store.removeList(listId);
		if (this.context) updateTodoWidget(this.context, undefined);
	}

	async view(): Promise<TodoListView | undefined> {
		if (!this.binding?.list_id) return undefined;
		return this.store.view(this.binding.list_id);
	}

	async getTask(taskId: string) {
		const view = await this.view();
		return view?.list.tasks.find((task) => task.id === taskId);
	}

	async digest(): Promise<string | undefined> {
		const view = await this.view();
		if (!view || view.summary.total === view.summary.completed) return undefined;
		const active = view.list.tasks.filter((task) => task.status === "in_progress");
		const lines = [
			`[PI TODO ACTIVE] ${view.summary.completed}/${view.summary.total} completed.`,
			`Snapshot: list ${view.list.id}, revision ${view.list.revision}. After an interruption or agent event, call todo_list before acting.`,
			`Direction: ${truncate(view.list.global_direction, DIGEST_DIRECTION_LIMIT)}`,
		];
		appendDigestSection(lines, "In progress", active, (task) => `${task.id} (${task.owner ?? "owned"})`);
		appendDigestSection(lines, "Ready", view.ready, (task) => `${task.id}: ${task.subject}`);
		appendDigestSection(lines, "Blocked", view.blocked, (task) => `${task.id} <- ${task.depends_on.join(",")}`);
		if (view.ready.length > 1 && hasAgentCapability(this.pi.getActiveTools())) {
			lines.push(
				"Several independent tasks are ready. Claim them, then use one background agent_start batch with worker and each claim's metadata. Use explore only for unbound read-only investigation.",
			);
		} else if (view.ready.length) {
			lines.push("Claim a ready task and continue it in the current session.");
		}
		return truncate(lines.join("\n"), DIGEST_CHAR_LIMIT);
	}

	async injectDigest(deliverAs: "followUp" | "nextTurn" = "nextTurn"): Promise<void> {
		const listId = this.binding?.list_id;
		if (!listId) return;
		const content = await this.digest();
		if (!content) {
			this.digestActive = false;
			this.turnsSinceReminder = 0;
			this.cancelDigest(listId);
			return;
		}
		this.pi.sendMessage(
			{ customType: TODO_DIGEST_MESSAGE, content, display: false },
			{
				triggerTurn: false,
				deliverAs,
				queue: {
					key: this.digestQueueKey(listId),
					resolve: async (signal) => {
						if (signal.aborted || this.binding?.list_id !== listId) return undefined;
						const latest = await this.digest();
						if (!latest || signal.aborted || this.binding?.list_id !== listId) return undefined;
						return { customType: TODO_DIGEST_MESSAGE, content: latest, display: false };
					},
				},
			},
		);
	}

	async onTurnEnd(): Promise<void> {
		if (!this.digestActive) {
			this.turnsSinceReminder = 0;
			return;
		}
		this.turnsSinceReminder++;
		if (this.turnsSinceReminder < PERIODIC_REMINDER_TURNS) return;
		this.turnsSinceReminder = 0;
		await this.injectDigest("followUp");
	}

	cancelDigest(listId = this.binding?.list_id): void {
		if (listId) this.pi.cancelMessage(this.digestQueueKey(listId));
	}

	async refresh(): Promise<void> {
		if (!this.context) return;
		const view = await this.view();
		updateTodoWidget(this.context, view);
		const diagnostic = this.store.takeDiagnostic();
		if (diagnostic) this.context.ui.notify(diagnostic, "warning");
	}

	private async record(document: TodoListDocument): Promise<TodoListDocument> {
		this.setBinding(document, true);
		await this.refresh();
		return document;
	}

	private setBinding(document: TodoListDocument, persist: boolean): void {
		const previousListId = this.binding?.list_id;
		if (previousListId && previousListId !== document.id) {
			this.cancelDigest(previousListId);
			this.turnsSinceReminder = 0;
		}
		this.binding = {
			version: 1,
			list_id: document.id,
			revision: document.revision,
			timestamp: new Date().toISOString(),
		};
		this.digestActive = document.tasks.some((task) => task.status !== "completed");
		if (!this.digestActive) {
			this.turnsSinceReminder = 0;
			this.cancelDigest(document.id);
		}
		if (persist) this.pi.appendEntry<TodoBindingEntry>(TODO_BINDING_ENTRY, this.binding);
	}

	private requireListId(): string {
		if (!this.binding?.list_id) throw new Error("No todo list is active");
		return this.binding.list_id;
	}

	private digestQueueKey(listId: string): string {
		return `pi-todo:${this.context?.sessionManager.getSessionId() ?? "unknown"}:${listId}`;
	}

	private async waitForOwnerEvidence(): Promise<void> {
		while (this.pendingOwnerEvidence.size > 0) {
			await Promise.allSettled([...this.pendingOwnerEvidence]);
		}
	}
}

function latestBinding(entries: readonly SessionEntry[]): TodoBindingEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== TODO_BINDING_ENTRY) continue;
		if (isBinding(entry.data)) return entry.data;
	}
	return undefined;
}

function isBinding(value: unknown): value is TodoBindingEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		(record.list_id === null || typeof record.list_id === "string") &&
		typeof record.revision === "number" &&
		typeof record.timestamp === "string"
	);
}

function parseAgentContext(raw: string | undefined): AgentContext | undefined {
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		const metadataValue = record.metadata ?? record;
		if (typeof metadataValue !== "object" || metadataValue === null) return undefined;
		return {
			agentId: typeof record.agentId === "string" ? record.agentId : undefined,
			metadata: metadataValue as Record<string, unknown>,
		};
	} catch {
		return undefined;
	}
}

function hasAgentCapability(activeTools: readonly string[]): boolean {
	return activeTools.includes("agent_start");
}

function appendDigestSection(
	lines: string[],
	label: string,
	tasks: readonly TodoListDocument["tasks"][number][],
	format: (task: TodoListDocument["tasks"][number]) => string,
): void {
	if (tasks.length === 0) return;
	const visible = tasks.slice(0, DIGEST_TASKS_PER_SECTION).map(format);
	if (tasks.length > visible.length) visible.push(`... ${tasks.length - visible.length} more`);
	lines.push(`${label}: ${visible.join("; ")}`);
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}
