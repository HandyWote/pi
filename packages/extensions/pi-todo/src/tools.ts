import type { ExtensionAPI } from "@handy_wote/pi-coding-agent";
import { Type } from "typebox";
import type { TodoRuntime } from "./runtime.ts";
import type { TodoDefinition, TodoListDocument, TodoListView, TodoTask } from "./types.ts";

const TodoId = Type.String({
	description: "Stable task id, such as T1",
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
});
const Subject = Type.String({ minLength: 1, maxLength: 500 });
const Description = Type.String({ maxLength: 10_000 });
const ActiveForm = Type.String({ maxLength: 500 });
const AcceptanceCriterion = Type.String({ minLength: 1, maxLength: 2000 });
const MAX_LIST_TASKS = 50;
const MAX_LIST_TEXT = 8000;
const TodoDefinitionSchema = Type.Object({
	id: TodoId,
	subject: Subject,
	description: Type.Optional(Description),
	active_form: Type.Optional(ActiveForm),
	depends_on: Type.Array(TodoId),
	acceptance_criteria: Type.Optional(Type.Array(AcceptanceCriterion)),
});

export function registerTodoTools(pi: ExtensionAPI, runtime: TodoRuntime): void {
	pi.registerTool({
		name: "write_todo",
		label: "Import Todo Plan",
		description: "Replace the current todo list with a validated dependency graph",
		promptSnippet: "Create a persistent dependency-aware todo list from an execution plan",
		promptGuidelines: [
			"Use write_todo when a [PI TODO PLAN] message asks you to structure confirmed multi-step work.",
			"Do not add mandatory review tasks. Add an ordinary review task only when review is useful for this work.",
		],
		parameters: Type.Object({
			items: Type.Array(TodoDefinitionSchema, { minItems: 1 }),
			global_direction: Type.String({ minLength: 1, maxLength: 20_000 }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const list = await runtime.replace(params.global_direction, params.items as TodoDefinition[]);
			return result(
				`Created ${list.tasks.length} tasks. Call todo_list to inspect ready work, then claim tasks before execution.`,
				documentDetails(list),
			);
		},
	});

	pi.registerTool({
		name: "todo_create",
		label: "Create Todo",
		description: "Add one or more tasks to the active list, or create a list when global_direction is supplied",
		promptSnippet: "Dynamically add tasks to the todo list",
		promptGuidelines: ["Add newly discovered work as normal tasks rather than replacing the active list."],
		parameters: Type.Object({
			items: Type.Array(TodoDefinitionSchema, { minItems: 1 }),
			global_direction: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const list = await runtime.add(params.items as TodoDefinition[], params.global_direction);
			return result(`Added ${params.items.length} task(s).`, documentDetails(list));
		},
	});

	pi.registerTool({
		name: "todo_list",
		label: "List Todos",
		description: "List active, ready, blocked, and completed tasks",
		promptSnippet: "Inspect todo state and ready work",
		promptGuidelines: [
			"Use todo_list after interruption or when selecting the next task.",
			"Several ready tasks may be claimed independently; there is no wave barrier.",
			"When at least two ready tasks are independent and have separate file ownership, claim them and delegate them in one background agent_start batch using worker.",
		],
		parameters: Type.Object({ ready_only: Type.Optional(Type.Boolean()) }),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const view = await runtime.view();
			if (!view) return result("No todo list is active.", undefined);
			const tasks = params.ready_only ? view.ready : view.list.tasks;
			return result(formatList(view, tasks), listDetails(view, tasks));
		},
	});

	pi.registerTool({
		name: "todo_get",
		label: "Get Todo",
		description: "Get complete details for one task",
		promptSnippet: "Inspect one todo task",
		parameters: Type.Object({ id: TodoId }),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const task = await runtime.getTask(params.id);
			if (!task) throw new Error(`Todo "${params.id}" does not exist`);
			return result(formatTask(task), task);
		},
	});

	pi.registerTool({
		name: "todo_update",
		label: "Update Todo",
		description: "Update task content, dependencies, or public status",
		promptSnippet: "Update or complete a todo task",
		promptGuidelines: [
			"Public task states are pending, in_progress, and completed.",
			"A worker completes its task explicitly after satisfying acceptance criteria; agent success alone is not completion.",
		],
		parameters: Type.Object({
			id: TodoId,
			subject: Type.Optional(Subject),
			description: Type.Optional(Type.Union([Description, Type.Null()])),
			active_form: Type.Optional(Type.Union([ActiveForm, Type.Null()])),
			depends_on: Type.Optional(Type.Array(TodoId)),
			acceptance_criteria: Type.Optional(Type.Union([Type.Array(AcceptanceCriterion), Type.Null()])),
			status: Type.Optional(
				Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
			),
			expected_revision: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const list = await runtime.update(params.id, { ...params });
			const task = requireTask(list, params.id);
			return result(`${params.id} is ${task.status} at revision ${task.revision}.`, task);
		},
	});

	pi.registerTool({
		name: "todo_claim",
		label: "Claim Todo",
		description: "Atomically claim one dependency-ready task",
		promptSnippet: "Claim a ready todo task before starting work",
		promptGuidelines: [
			"Pass expected_revision when coordinating concurrent workers to reject stale claims.",
			"Copy the returned metadata unchanged into the matching agent_start item.",
		],
		parameters: Type.Object({
			id: TodoId,
			owner: Type.Optional(Type.String({ minLength: 1 })),
			expected_revision: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const claim = await runtime.claim(params.id, params.owner, params.expected_revision);
			const listId = runtime.getListId();
			if (!listId) throw new Error("No todo list is active");
			const metadata = {
				"pi.todo/list-id": listId,
				"pi.todo/task-id": params.id,
			};
			const batchItem = { agent: "worker", task: claim.task.subject, metadata };
			return result(
				`Claimed ${params.id} for ${claim.task.owner}. Agent batch item:\n${JSON.stringify(batchItem)}`,
				{
					...claim,
					metadata,
					agent_start_item: batchItem,
				},
			);
		},
	});

	pi.registerTool({
		name: "todo_release",
		label: "Release Todo",
		description: "Return an in-progress task to pending",
		promptSnippet: "Return unfinished claimed work to pending",
		parameters: Type.Object({ id: TodoId }),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const list = await runtime.release(params.id);
			return result(
				`Released ${params.id}; it is ready when its dependencies are complete.`,
				requireTask(list, params.id),
			);
		},
	});

	pi.registerTool({
		name: "todo_delete",
		label: "Delete Todo",
		description: "Delete an unneeded task and remove it from dependent task edges",
		promptSnippet: "Remove an unneeded todo task",
		parameters: Type.Object({ id: TodoId }),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const list = await runtime.delete(params.id);
			return result(`Deleted ${params.id} and cleaned dependent edges.`, documentDetails(list));
		},
	});
}

function result<T>(text: string, details: T) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatList(view: TodoListView, tasks: readonly TodoTask[]): string {
	const summary = view.summary;
	const heading = `${summary.completed}/${summary.total} completed; ${summary.in_progress} active; ${summary.ready} ready; ${summary.blocked} blocked`;
	if (!tasks.length) return `${heading}\nNo matching tasks.`;
	const visible = tasks.slice(0, MAX_LIST_TASKS).map(formatTask);
	if (tasks.length > visible.length) visible.push(`... ${tasks.length - visible.length} more tasks`);
	return truncate(`${heading}\n${visible.join("\n")}`, MAX_LIST_TEXT);
}

function formatTask(task: TodoTask): string {
	const owner = task.owner ? ` owner=${task.owner}` : "";
	const dependencies = task.depends_on.length ? ` depends_on=${task.depends_on.join(",")}` : "";
	return `[${task.status}] ${task.id}: ${task.subject}${owner}${dependencies} revision=${task.revision}`;
}

function requireTask(list: TodoListDocument, id: string): TodoTask {
	const task = list.tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Todo "${id}" does not exist`);
	return task;
}

function documentDetails(list: TodoListDocument) {
	return { list_id: list.id, revision: list.revision, task_count: list.tasks.length };
}

function listDetails(view: TodoListView, tasks: readonly TodoTask[]) {
	const visible = tasks.slice(0, MAX_LIST_TASKS).map((task) => ({
		id: task.id,
		subject: truncate(task.subject, 500),
		status: task.status,
		owner: task.owner,
		depends_on: task.depends_on,
		revision: task.revision,
	}));
	return {
		list_id: view.list.id,
		revision: view.list.revision,
		global_direction: truncate(view.list.global_direction, 1000),
		summary: view.summary,
		tasks: visible,
		truncated_tasks: tasks.length - visible.length,
	};
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}
