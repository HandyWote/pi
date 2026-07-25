import type { TodoDefinition } from "./types.ts";

const TODO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class TodoValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TodoValidationError";
	}
}

export function resolveWaves(items: readonly TodoDefinition[]): Map<string, number> {
	if (items.length === 0) {
		throw new TodoValidationError("Todo list must contain at least one item");
	}

	const byId = new Map<string, TodoDefinition>();
	const dependents = new Map<string, string[]>();
	const indegree = new Map<string, number>();

	for (const item of items) {
		if (!TODO_ID_PATTERN.test(item.id)) {
			throw new TodoValidationError(
				`Invalid todo id "${item.id}"; use 1-64 letters, numbers, dots, underscores, or hyphens`,
			);
		}
		if (byId.has(item.id)) {
			throw new TodoValidationError(`Duplicate todo id "${item.id}"`);
		}
		if (item.title.trim().length === 0) {
			throw new TodoValidationError(`Todo "${item.id}" must have a title`);
		}
		if (item.acceptance_criteria.length === 0 || item.acceptance_criteria.some((criterion) => !criterion.trim())) {
			throw new TodoValidationError(`Todo "${item.id}" must have non-empty acceptance criteria`);
		}
		byId.set(item.id, item);
		dependents.set(item.id, []);
		indegree.set(item.id, item.depends_on.length);
	}

	for (const item of items) {
		const uniqueDependencies = new Set(item.depends_on);
		if (uniqueDependencies.size !== item.depends_on.length) {
			throw new TodoValidationError(`Todo "${item.id}" contains duplicate dependencies`);
		}
		for (const dependency of item.depends_on) {
			if (!byId.has(dependency)) {
				throw new TodoValidationError(`Todo "${item.id}" depends on unknown todo "${dependency}"`);
			}
			dependents.get(dependency)?.push(item.id);
		}
	}

	let ready = items.filter((item) => item.depends_on.length === 0).map((item) => item.id);
	const waves = new Map<string, number>();
	let wave = 1;
	let visited = 0;

	while (ready.length > 0) {
		const next: string[] = [];
		for (const id of ready) {
			waves.set(id, wave);
			visited++;
			for (const dependent of dependents.get(id) ?? []) {
				const remaining = (indegree.get(dependent) ?? 0) - 1;
				indegree.set(dependent, remaining);
				if (remaining === 0) next.push(dependent);
			}
		}
		ready = next;
		wave++;
	}

	if (visited !== items.length) {
		const cyclicIds = items.filter((item) => !waves.has(item.id)).map((item) => item.id);
		throw new TodoValidationError(`Todo dependency graph contains a cycle: ${cyclicIds.join(", ")}`);
	}

	return waves;
}
