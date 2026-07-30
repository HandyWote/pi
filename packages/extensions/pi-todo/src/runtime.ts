import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionStartEvent } from "@handy_wote/pi-coding-agent";
import { getAgentDir } from "@handy_wote/pi-coding-agent";
import { FileTodoStore } from "./store.ts";
import type { TodoBindingEntry, TodoDefinition, TodoListDocument, TodoListView } from "./types.ts";
import { updateTodoWidget } from "./widget.ts";

export const TODO_BINDING_ENTRY = "pi-todo-binding";
export const TODO_DIGEST_MESSAGE = "pi-todo-digest";

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

	constructor(pi: ExtensionAPI, options: TodoRuntimeOptions = {}) {
		this.pi = pi;
		this.store = new FileTodoStore(options.dataDir ?? join(getAgentDir(), "todo", "lists"));
		this.agentContext = parseAgentContext(process.env.PI_AGENT_CONTEXT);
	}

	getListId(): string | undefined {
		return this.binding?.list_id ?? undefined;
	}

	getTaskContext(): { listId: string; taskId: string; claimToken: string; agentId?: string } | undefined {
		const metadata = this.agentContext?.metadata;
		if (!metadata) return undefined;
		const listId = metadata["pi.todo/list-id"];
		const taskId = metadata["pi.todo/task-id"];
		const claimToken = metadata["pi.todo/claim-token"];
		if (typeof listId !== "string" || typeof taskId !== "string" || typeof claimToken !== "string") return undefined;
		return { listId, taskId, claimToken, agentId: this.agentContext?.agentId };
	}

	async initialize(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		const agentTask = this.getTaskContext();
		if (agentTask) {
			const list = await this.store.read(agentTask.listId);
			this.setBinding(list, true);
			await this.refresh();
			return;
		}

		if (event.reason === "new") {
			this.binding = undefined;
			updateTodoWidget(ctx, undefined);
			return;
		}

		const restored = latestBinding(ctx.sessionManager.getBranch());
		if (!restored?.list_id) {
			this.binding = undefined;
			updateTodoWidget(ctx, undefined);
			return;
		}

		if (event.reason === "fork") {
			const cloned = await this.store.clone(restored.list_id, restored.revision);
			this.setBinding(cloned, true);
		} else {
			const list = await this.store.read(restored.list_id);
			this.setBinding(list, false);
		}
		await this.refresh();
	}

	async restoreTree(ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		const restored = latestBinding(ctx.sessionManager.getBranch());
		if (!restored?.list_id) {
			this.binding = undefined;
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
		const listId = this.requireListId();
		const taskContext = this.getTaskContext();
		if (patch.claim_token === undefined && taskContext?.listId === listId && taskContext.taskId === taskId) {
			patch.claim_token = taskContext.claimToken;
		}
		if (patch.claim_token === undefined) {
			const task = await this.getTask(taskId);
			const sessionOwner = this.context?.sessionManager.getSessionId();
			if (task?.status === "in_progress" && task.owner === sessionOwner) patch.claim_token = task.claim_token;
		}
		return this.record(await this.store.update(listId, taskId, patch));
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

	async release(taskId: string, owner: string, claimToken: string): Promise<TodoListDocument> {
		return this.record(await this.store.release(this.requireListId(), taskId, owner, claimToken));
	}

	async transfer(taskId: string, owner: string, claimToken: string): Promise<TodoListDocument> {
		return this.record(await this.store.transfer(this.requireListId(), taskId, owner, claimToken));
	}

	async delete(taskId: string): Promise<TodoListDocument> {
		return this.record(await this.store.delete(this.requireListId(), taskId));
	}

	async clear(): Promise<void> {
		const listId = this.binding?.list_id;
		this.binding = undefined;
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
			`Direction: ${view.list.global_direction}`,
		];
		if (active.length) {
			lines.push(`In progress: ${active.map((task) => `${task.id} (${task.owner ?? "owned"})`).join(", ")}`);
		}
		if (view.ready.length) lines.push(`Ready: ${view.ready.map((task) => `${task.id}: ${task.subject}`).join("; ")}`);
		if (view.blocked.length) {
			lines.push(`Blocked: ${view.blocked.map((task) => `${task.id} <- ${task.depends_on.join(",")}`).join("; ")}`);
		}
		if (view.ready.length > 1 && hasAgentCapability(this.pi.getActiveTools())) {
			lines.push("Several independent tasks are ready. Prefer parallel delegation when appropriate.");
		} else if (view.ready.length) {
			lines.push("Claim a ready task and continue it in the current session.");
		}
		return lines.join("\n");
	}

	async injectDigest(deliverAs: "followUp" | "nextTurn" = "nextTurn"): Promise<void> {
		const content = await this.digest();
		if (!content) return;
		this.pi.sendMessage(
			{ customType: TODO_DIGEST_MESSAGE, content, display: false },
			{ triggerTurn: false, deliverAs },
		);
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
		this.binding = {
			version: 1,
			list_id: document.id,
			revision: document.revision,
			timestamp: new Date().toISOString(),
		};
		if (persist) this.pi.appendEntry<TodoBindingEntry>(TODO_BINDING_ENTRY, this.binding);
	}

	private requireListId(): string {
		if (!this.binding?.list_id) throw new Error("No todo list is active");
		return this.binding.list_id;
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
	return activeTools.some((name) => name.toLowerCase().includes("agent"));
}
