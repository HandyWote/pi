import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getBlockedTasks, getReadyTasks, TodoValidationError, validateDefinitions } from "./scheduler.ts";
import type {
	TodoClaim,
	TodoDefinition,
	TodoListDocument,
	TodoListView,
	TodoSnapshot,
	TodoStatus,
	TodoTask,
} from "./types.ts";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 3000;
const HISTORY_LIMIT = 200;

export class TodoPersistenceError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TodoPersistenceError";
	}
}

function cloneTask(task: TodoTask): TodoTask {
	return {
		...task,
		depends_on: [...task.depends_on],
		acceptance_criteria: task.acceptance_criteria ? [...task.acceptance_criteria] : undefined,
	};
}

function snapshot(document: TodoListDocument): TodoSnapshot {
	return {
		revision: document.revision,
		global_direction: document.global_direction,
		tasks: document.tasks.map(cloneTask),
		tombstones: document.tombstones.map((entry) => ({ ...entry })),
		created_at: document.created_at,
		updated_at: document.updated_at,
	};
}

function cloneDocument(document: TodoListDocument): TodoListDocument {
	return {
		...snapshot(document),
		version: 1,
		id: document.id,
		history: document.history.map((entry) => ({
			...entry,
			tasks: entry.tasks.map(cloneTask),
			tombstones: entry.tombstones.map((tombstone) => ({ ...tombstone })),
		})),
	};
}

function definitions(tasks: readonly TodoTask[]): TodoDefinition[] {
	return tasks.map(({ id, subject, description, active_form, depends_on, acceptance_criteria }) => ({
		id,
		subject,
		description,
		active_form,
		depends_on,
		acceptance_criteria,
	}));
}

function assertDocument(value: unknown, path: string): asserts value is TodoListDocument {
	if (typeof value !== "object" || value === null) throw new TodoPersistenceError(`Invalid todo data in ${path}`);
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.id !== "string" || !Array.isArray(record.tasks)) {
		throw new TodoPersistenceError(`Unsupported or malformed todo data in ${path}`);
	}
}

export class FileTodoStore {
	private readonly rootDir: string;
	private diagnostic: string | undefined;

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	takeDiagnostic(): string | undefined {
		const diagnostic = this.diagnostic;
		this.diagnostic = undefined;
		return diagnostic;
	}

	async create(globalDirection: string, items: readonly TodoDefinition[], id = randomUUID()): Promise<TodoListDocument> {
		if (!globalDirection.trim()) throw new TodoValidationError("Global direction must not be empty");
		validateDefinitions(items);
		await mkdir(this.rootDir, { recursive: true });
		return this.withLock(id, async () => {
			const path = this.documentPath(id);
			try {
				await readFile(path);
				throw new TodoValidationError(`Todo list "${id}" already exists`);
			} catch (error) {
				if (error instanceof TodoValidationError) throw error;
				if (!isNotFound(error)) throw error;
			}
			const now = new Date().toISOString();
			const tasks = items.map((item) => ({
				...item,
				depends_on: [...item.depends_on],
				acceptance_criteria: item.acceptance_criteria ? [...item.acceptance_criteria] : undefined,
				status: "pending" as const,
				created_at: now,
				updated_at: now,
				revision: 1,
			}));
			const document: TodoListDocument = {
				version: 1,
				id,
				revision: 1,
				global_direction: globalDirection.trim(),
				tasks,
				tombstones: [],
				created_at: now,
				updated_at: now,
				history: [],
			};
			await this.writeDocument(document);
			return cloneDocument(document);
		});
	}

	async read(id: string, revision?: number): Promise<TodoListDocument> {
		const document = await this.readDocument(id);
		if (revision === undefined || revision === document.revision) return cloneDocument(document);
		const historical = document.history.find((entry) => entry.revision === revision);
		if (!historical) throw new TodoValidationError(`Todo list "${id}" has no revision ${revision}`);
		return { ...historical, version: 1, id, history: document.history.map((entry) => ({ ...entry })) };
	}

	async view(id: string, revision?: number): Promise<TodoListView> {
		const list = await this.read(id, revision);
		const ready = getReadyTasks(list.tasks).map(cloneTask);
		const blocked = getBlockedTasks(list.tasks).map(cloneTask);
		return {
			list,
			ready,
			blocked,
			summary: {
				total: list.tasks.length,
				pending: list.tasks.filter((task) => task.status === "pending").length,
				in_progress: list.tasks.filter((task) => task.status === "in_progress").length,
				completed: list.tasks.filter((task) => task.status === "completed").length,
				ready: ready.length,
				blocked: blocked.length,
			},
		};
	}

	async add(id: string, items: readonly TodoDefinition[]): Promise<TodoListDocument> {
		if (items.length === 0) throw new TodoValidationError("At least one task is required");
		return this.mutate(id, (document, now) => {
			const next = [
				...document.tasks,
				...items.map((item) => ({
					...item,
					depends_on: [...item.depends_on],
					acceptance_criteria: item.acceptance_criteria ? [...item.acceptance_criteria] : undefined,
					status: "pending" as const,
					created_at: now,
					updated_at: now,
					revision: document.revision + 1,
				})),
			];
			validateDefinitions(definitions(next));
			document.tasks = next;
		});
	}

	async update(
		listId: string,
		taskId: string,
		patch: {
			subject?: string;
			description?: string | null;
			active_form?: string | null;
			depends_on?: string[];
			acceptance_criteria?: string[] | null;
			status?: TodoStatus;
			owner?: string | null;
			claim_token?: string;
			expected_revision?: number;
		},
	): Promise<TodoListDocument> {
		return this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (patch.expected_revision !== undefined && patch.expected_revision !== task.revision) {
				throw new TodoValidationError(
					`Todo "${taskId}" revision changed from ${patch.expected_revision} to ${task.revision}`,
				);
			}
			if (patch.claim_token !== undefined && patch.claim_token !== task.claim_token) {
				throw new TodoValidationError(`Todo "${taskId}" claim token does not match`);
			}
			if (patch.subject !== undefined) task.subject = patch.subject;
			if (patch.description !== undefined) task.description = patch.description?.trim() || undefined;
			if (patch.active_form !== undefined) task.active_form = patch.active_form?.trim() || undefined;
			if (patch.depends_on !== undefined) task.depends_on = [...patch.depends_on];
			if (patch.acceptance_criteria !== undefined) {
				task.acceptance_criteria = patch.acceptance_criteria?.map((criterion) => criterion.trim()) ?? undefined;
			}
			if (patch.owner !== undefined) task.owner = patch.owner?.trim() || undefined;
			if (patch.status !== undefined) {
				if (patch.status === "in_progress" && !task.owner) {
					throw new TodoValidationError(`Todo "${taskId}" must be claimed before becoming in_progress`);
				}
				task.status = patch.status;
				if (patch.status !== "in_progress") {
					task.owner = undefined;
					task.claim_token = undefined;
				}
			}
			validateDefinitions(definitions(document.tasks));
			task.updated_at = now;
			task.revision = document.revision + 1;
		});
	}

	async claim(listId: string, taskId: string, owner: string, expectedRevision?: number): Promise<TodoClaim> {
		if (!owner.trim()) throw new TodoValidationError("Claim owner must not be empty");
		let claimToken = "";
		const list = await this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (expectedRevision !== undefined && task.revision !== expectedRevision) {
				throw new TodoValidationError(`Todo "${taskId}" revision changed from ${expectedRevision} to ${task.revision}`);
			}
			if (task.status !== "pending") throw new TodoValidationError(`Todo "${taskId}" is ${task.status}, not pending`);
			const readyIds = new Set(getReadyTasks(document.tasks).map((candidate) => candidate.id));
			if (!readyIds.has(taskId)) throw new TodoValidationError(`Todo "${taskId}" is blocked by dependencies`);
			claimToken = randomUUID();
			task.status = "in_progress";
			task.owner = owner.trim();
			task.claim_token = claimToken;
			task.updated_at = now;
			task.revision = document.revision + 1;
		});
		return { task: cloneTask(requireTask(list, taskId)), claim_token: claimToken };
	}

	async release(listId: string, taskId: string, owner: string, claimToken: string): Promise<TodoListDocument> {
		return this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (task.status !== "in_progress" || task.owner !== owner || task.claim_token !== claimToken) {
				throw new TodoValidationError(`Todo "${taskId}" is not owned by "${owner}" with the supplied claim token`);
			}
			task.status = "pending";
			task.owner = undefined;
			task.claim_token = undefined;
			task.updated_at = now;
			task.revision = document.revision + 1;
		});
	}

	async delete(listId: string, taskId: string): Promise<TodoListDocument> {
		return this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (task.status === "in_progress") throw new TodoValidationError(`Todo "${taskId}" must be released before deletion`);
			document.tasks = document.tasks
				.filter((candidate) => candidate.id !== taskId)
				.map((candidate) => ({ ...candidate, depends_on: candidate.depends_on.filter((id) => id !== taskId) }));
			document.tombstones.push({ id: taskId, deleted_at: now, revision: document.revision + 1 });
			validateDefinitions(definitions(document.tasks), true);
		});
	}

	async clone(sourceId: string, revision?: number, targetId = randomUUID()): Promise<TodoListDocument> {
		const source = await this.read(sourceId, revision);
		return this.withLock(targetId, async () => {
			const now = new Date().toISOString();
			const document: TodoListDocument = {
				...source,
				id: targetId,
				created_at: now,
				updated_at: now,
				tasks: source.tasks.map((task) => ({ ...cloneTask(task), created_at: now, updated_at: now })),
				history: [],
			};
			await this.writeDocument(document);
			return cloneDocument(document);
		});
	}

	async removeList(id: string): Promise<void> {
		await this.withLock(id, async () => rm(this.listDir(id), { recursive: true, force: true }));
	}

	private async mutate(id: string, operation: (document: TodoListDocument, now: string) => void): Promise<TodoListDocument> {
		return this.withLock(id, async () => {
			const document = await this.readDocument(id);
			const previous = snapshot(document);
			const now = new Date().toISOString();
			operation(document, now);
			document.history.push(previous);
			if (document.history.length > HISTORY_LIMIT) document.history.splice(0, document.history.length - HISTORY_LIMIT);
			document.revision++;
			document.updated_at = now;
			await this.writeDocument(document);
			return cloneDocument(document);
		});
	}

	private async readDocument(id: string): Promise<TodoListDocument> {
		const path = this.documentPath(id);
		try {
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			assertDocument(value, path);
			validateDefinitions(definitions(value.tasks), true);
			return value;
		} catch (error) {
			if (isNotFound(error)) throw new TodoPersistenceError(`Todo list "${id}" does not exist`, { cause: error });
			const backupPath = this.backupPath(id);
			try {
				const value: unknown = JSON.parse(await readFile(backupPath, "utf8"));
				assertDocument(value, backupPath);
				validateDefinitions(definitions(value.tasks), true);
				this.diagnostic = `Recovered todo list "${id}" from backup after ${path} became unreadable`;
				return value;
			} catch (backupError) {
				throw new TodoPersistenceError(`Todo list "${id}" is corrupt and no valid backup is available`, {
					cause: backupError,
				});
			}
		}
	}

	private async writeDocument(document: TodoListDocument): Promise<void> {
		const directory = this.listDir(document.id);
		const path = this.documentPath(document.id);
		await mkdir(directory, { recursive: true });
		try {
			await copyFile(path, this.backupPath(document.id));
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		const temporary = join(directory, `tasks.${process.pid}.${randomUUID()}.tmp`);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	}

	private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
		await mkdir(join(this.rootDir, ".locks"), { recursive: true });
		const lockPath = join(this.rootDir, ".locks", `${id}.lock`);
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		while (true) {
			try {
				await mkdir(lockPath);
				break;
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				if (Date.now() >= deadline) throw new TodoPersistenceError(`Timed out waiting for todo list "${id}" lock`);
				await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
			}
		}
		try {
			return await operation();
		} finally {
			await rm(lockPath, { recursive: true, force: true });
		}
	}

	private listDir(id: string): string {
		if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new TodoValidationError(`Invalid todo list id "${id}"`);
		return join(this.rootDir, id);
	}

	private documentPath(id: string): string {
		return join(this.listDir(id), "tasks.json");
	}

	private backupPath(id: string): string {
		return join(this.listDir(id), "tasks.json.bak");
	}
}

function requireTask(document: TodoListDocument, taskId: string): TodoTask {
	const task = document.tasks.find((candidate) => candidate.id === taskId);
	if (!task) throw new TodoValidationError(`Todo "${taskId}" does not exist`);
	return task;
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
