export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoDefinition {
	id: string;
	subject: string;
	description?: string;
	active_form?: string;
	depends_on: string[];
	acceptance_criteria?: string[];
}

export interface TodoTask extends TodoDefinition {
	status: TodoStatus;
	owner?: string;
	created_at: string;
	updated_at: string;
	revision: number;
}

export interface TodoTombstone {
	id: string;
	deleted_at: string;
	revision: number;
}

export interface TodoSnapshot {
	revision: number;
	global_direction: string;
	tasks: TodoTask[];
	tombstones: TodoTombstone[];
	created_at: string;
	updated_at: string;
}

export interface TodoListDocument extends TodoSnapshot {
	version: 1;
	id: string;
	history: TodoSnapshot[];
}

export interface TodoSummary {
	total: number;
	pending: number;
	in_progress: number;
	completed: number;
	ready: number;
	blocked: number;
}

export interface TodoListView {
	list: TodoListDocument;
	ready: TodoTask[];
	blocked: TodoTask[];
	summary: TodoSummary;
}

export interface TodoClaim {
	task: TodoTask;
}

export interface TodoBindingEntry {
	version: 1;
	list_id: string | null;
	revision: number;
	timestamp: string;
}

export interface TodoAgentMetadata {
	"pi.todo/list-id": string;
	"pi.todo/task-id": string;
}

export interface AgentLifecycleEvent {
	version: 2;
	eventId: string;
	runId: string;
	agentId: string;
	parentSessionId: string;
	status: "queued" | "started" | "running" | "completed" | "failed" | "stopped" | "interrupted";
	timestamp: string;
	metadata: Record<string, unknown>;
}
