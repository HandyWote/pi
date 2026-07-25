export const TODO_STATUSES = [
	"pending",
	"running",
	"executed",
	"done",
	"fix-needed",
	"off-target",
	"failed",
	"blocked",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoSize = "small" | "big";
export type MarkStatus = "done" | "fix-needed" | "off-target" | "failed";

export interface TodoDefinition {
	id: string;
	title: string;
	depends_on: string[];
	acceptance_criteria: string[];
	size_hint: TodoSize;
	files_in_scope?: string[];
}

export interface WriteTodoParams {
	items: TodoDefinition[];
	global_direction: string;
}

export interface TodoItem extends TodoDefinition {
	status: TodoStatus;
	wave: number;
	note?: string;
	agent_id?: string;
	fix_attempts: number;
	reassign_attempts: number;
}

export interface WaveTask {
	id: string;
	title: string;
	acceptance_criteria: string[];
	size_hint: TodoSize;
	files_in_scope?: string[];
}

export interface NextWaveResult {
	wave: number;
	tasks: WaveTask[];
	complete: boolean;
	waiting: boolean;
}

export interface TodoSummary {
	total: number;
	done: number;
	pending: number;
	failed: number;
	blocked: number;
}

export interface MarkResult {
	item: TodoItem;
	summary: TodoSummary;
	exhausted: boolean;
}

export interface SubagentEvent {
	id: string;
	description: string;
	error?: string;
	status?: string;
}
