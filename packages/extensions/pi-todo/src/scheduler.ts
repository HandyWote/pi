import type { TodoDefinition, TodoTask } from "./types.ts";

export const TODO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class TodoValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TodoValidationError";
	}
}

export function validateDefinitions(items: readonly TodoDefinition[], allowEmpty = false): void {
	if (!allowEmpty && items.length === 0) throw new TodoValidationError("Todo list must contain at least one task");
	const byId = new Map<string, TodoDefinition>();
	for (const item of items) {
		if (!TODO_ID_PATTERN.test(item.id)) {
			throw new TodoValidationError(
				`Invalid todo id "${item.id}"; use 1-64 letters, numbers, dots, underscores, or hyphens`,
			);
		}
		if (byId.has(item.id)) throw new TodoValidationError(`Duplicate todo id "${item.id}"`);
		if (!item.subject.trim()) throw new TodoValidationError(`Todo "${item.id}" must have a subject`);
		if (item.depends_on.includes(item.id)) throw new TodoValidationError(`Todo "${item.id}" cannot depend on itself`);
		if (new Set(item.depends_on).size !== item.depends_on.length) {
			throw new TodoValidationError(`Todo "${item.id}" contains duplicate dependencies`);
		}
		if (item.acceptance_criteria?.some((criterion) => !criterion.trim())) {
			throw new TodoValidationError(`Todo "${item.id}" contains an empty acceptance criterion`);
		}
		byId.set(item.id, item);
	}

	for (const item of items) {
		for (const dependency of item.depends_on) {
			if (!byId.has(dependency)) {
				throw new TodoValidationError(`Todo "${item.id}" depends on unknown todo "${dependency}"`);
			}
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new TodoValidationError(`Todo dependency graph contains a cycle involving "${id}"`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of byId.keys()) visit(id);
}

export function getReadyTasks(tasks: readonly TodoTask[]): TodoTask[] {
	const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
	return tasks.filter((task) => task.status === "pending" && task.depends_on.every((id) => completed.has(id)));
}

export function getBlockedTasks(tasks: readonly TodoTask[]): TodoTask[] {
	const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
	return tasks.filter((task) => task.status === "pending" && task.depends_on.some((id) => !completed.has(id)));
}
