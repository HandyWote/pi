import { resolveWaves, TodoValidationError } from "./scheduler.ts";
import type {
	MarkResult,
	MarkStatus,
	NextWaveResult,
	TodoItem,
	TodoStatus,
	TodoSummary,
	WriteTodoParams,
} from "./types.ts";

const ACTIVE_STATUSES = new Set<TodoStatus>(["running", "executed", "fix-needed"]);
const FAILURE_STATUSES = new Set<TodoStatus>(["failed", "off-target"]);

function cloneItem(item: TodoItem): TodoItem {
	return {
		...item,
		depends_on: [...item.depends_on],
		acceptance_criteria: [...item.acceptance_criteria],
		files_in_scope: item.files_in_scope ? [...item.files_in_scope] : undefined,
	};
}

export class TodoStore {
	private items = new Map<string, TodoItem>();
	private agentTasks = new Map<string, string>();
	private direction = "";

	clear(): void {
		this.items.clear();
		this.agentTasks.clear();
		this.direction = "";
	}

	write(params: WriteTodoParams): TodoItem[] {
		if (!params.global_direction.trim()) {
			throw new TodoValidationError("Global direction must not be empty");
		}

		const waves = resolveWaves(params.items);
		const nextItems = new Map<string, TodoItem>();
		for (const definition of params.items) {
			nextItems.set(definition.id, {
				...definition,
				depends_on: [...definition.depends_on],
				acceptance_criteria: [...definition.acceptance_criteria],
				files_in_scope: definition.files_in_scope ? [...definition.files_in_scope] : undefined,
				status: "pending",
				wave: waves.get(definition.id)!,
				fix_attempts: 0,
				reassign_attempts: 0,
			});
		}

		this.items = nextItems;
		this.agentTasks.clear();
		this.direction = params.global_direction.trim();
		return this.getItems();
	}

	hasPlan(): boolean {
		return this.items.size > 0;
	}

	getGlobalDirection(): string {
		return this.direction;
	}

	getItems(): TodoItem[] {
		return [...this.items.values()].map(cloneItem);
	}

	getItem(id: string): TodoItem | undefined {
		const item = this.items.get(id);
		return item ? cloneItem(item) : undefined;
	}

	nextWave(): NextWaveResult {
		if (!this.hasPlan()) {
			throw new TodoValidationError("No todo plan is active; call write_todo first");
		}

		const active = [...this.items.values()].filter((item) => ACTIVE_STATUSES.has(item.status));
		if (active.length > 0) {
			return {
				wave: Math.min(...active.map((item) => item.wave)),
				tasks: [],
				complete: false,
				waiting: true,
			};
		}

		const ready = [...this.items.values()].filter(
			(item) =>
				item.status === "pending" &&
				item.depends_on.every((dependency) => this.items.get(dependency)?.status === "done"),
		);
		if (ready.length === 0) {
			return { wave: 0, tasks: [], complete: true, waiting: false };
		}

		const wave = Math.min(...ready.map((item) => item.wave));
		const tasks = ready.filter((item) => item.wave === wave);
		for (const task of tasks) task.status = "running";

		return {
			wave,
			tasks: tasks.map((task) => ({
				id: task.id,
				title: task.title,
				acceptance_criteria: [...task.acceptance_criteria],
				size_hint: task.size_hint,
				files_in_scope: task.files_in_scope ? [...task.files_in_scope] : undefined,
			})),
			complete: false,
			waiting: false,
		};
	}

	mark(id: string, status: MarkStatus, note?: string): MarkResult {
		const item = this.items.get(id);
		if (!item) throw new TodoValidationError(`Todo "${id}" does not exist`);
		if (item.status === "pending" || item.status === "blocked") {
			throw new TodoValidationError(`Todo "${id}" cannot be marked while ${item.status}`);
		}
		if (item.status === "failed" || item.status === "done") {
			throw new TodoValidationError(`Todo "${id}" is already ${item.status}`);
		}
		if (item.status === "running" && item.agent_id) {
			throw new TodoValidationError(`Todo "${id}" is still running in agent "${item.agent_id}"`);
		}

		let exhausted = false;
		if (status === "fix-needed") {
			item.fix_attempts++;
			if (item.fix_attempts > 2) {
				item.status = "failed";
				item.note = note?.trim() || "Fix/review limit exhausted";
				exhausted = true;
			} else {
				item.status = "fix-needed";
				item.note = note?.trim() || undefined;
			}
		} else if (status === "off-target") {
			if (item.reassign_attempts >= 1) {
				item.status = "failed";
				item.note = note?.trim() || "Reassignment limit exhausted";
				exhausted = true;
			} else {
				item.status = "off-target";
				item.note = note?.trim() || undefined;
			}
		} else {
			item.status = status;
			item.note = note?.trim() || undefined;
		}
		if (item.agent_id) this.agentTasks.delete(item.agent_id);
		item.agent_id = undefined;

		this.recomputeBlocked();
		return { item: cloneItem(item), summary: this.getSummary(), exhausted };
	}

	bindAgent(taskId: string, agentId: string): boolean {
		const item = this.items.get(taskId);
		if (!item || this.agentTasks.has(agentId)) return false;

		if (item.status === "off-target" && item.reassign_attempts < 1) {
			item.reassign_attempts++;
			item.status = "running";
			item.note = undefined;
			this.recomputeBlocked();
		} else if (item.status === "fix-needed") {
			item.status = "running";
		} else if (item.status !== "running" || item.agent_id) {
			return false;
		}

		item.agent_id = agentId;
		this.agentTasks.set(agentId, taskId);
		return true;
	}

	settleAgent(agentId: string, succeeded: boolean, error?: string): boolean {
		const taskId = this.agentTasks.get(agentId);
		if (!taskId) return false;
		this.agentTasks.delete(agentId);
		const item = this.items.get(taskId);
		if (!item || item.agent_id !== agentId || item.status !== "running") return false;

		item.agent_id = undefined;
		if (succeeded) {
			item.status = "executed";
		} else {
			item.status = "failed";
			item.note = error?.trim() || "Subagent execution failed";
			this.recomputeBlocked();
		}
		return true;
	}

	getSummary(): TodoSummary {
		const items = [...this.items.values()];
		return {
			total: items.length,
			done: items.filter((item) => item.status === "done").length,
			pending: items.filter((item) => ["pending", "running", "executed", "fix-needed"].includes(item.status)).length,
			failed: items.filter((item) => FAILURE_STATUSES.has(item.status)).length,
			blocked: items.filter((item) => item.status === "blocked").length,
		};
	}

	private recomputeBlocked(): void {
		for (const item of this.items.values()) {
			if (item.status === "blocked") item.status = "pending";
		}

		let changed = true;
		while (changed) {
			changed = false;
			for (const item of this.items.values()) {
				if (item.status !== "pending") continue;
				if (
					item.depends_on.some((dependency) => {
						const status = this.items.get(dependency)?.status;
						return status === "failed" || status === "off-target" || status === "blocked";
					})
				) {
					item.status = "blocked";
					changed = true;
				}
			}
		}
	}
}
