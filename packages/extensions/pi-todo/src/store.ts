import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
	getBlockedTasks,
	getReadyTasks,
	TODO_ID_PATTERN,
	TodoValidationError,
	validateDefinitions,
} from "./scheduler.ts";
import type {
	TodoClaim,
	TodoDefinition,
	TodoListDocument,
	TodoListView,
	TodoSnapshot,
	TodoStatus,
	TodoTask,
} from "./types.ts";
import { TODO_STATUSES } from "./types.ts";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 3000;
const FOREIGN_LOCK_STALE_MS = 30_000;
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

function assertDocument(value: unknown, path: string, expectedId: string): asserts value is TodoListDocument {
	if (typeof value !== "object" || value === null) throw new TodoPersistenceError(`Invalid todo data in ${path}`);
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		record.id !== expectedId ||
		!isPositiveInteger(record.revision) ||
		typeof record.global_direction !== "string" ||
		!Array.isArray(record.tasks) ||
		!Array.isArray(record.tombstones) ||
		!Array.isArray(record.history) ||
		!isTimestamp(record.created_at) ||
		!isTimestamp(record.updated_at)
	) {
		throw new TodoPersistenceError(`Unsupported or malformed todo data in ${path}`);
	}
	for (const task of record.tasks) assertTask(task, record.revision, path);
	for (const tombstone of record.tombstones) assertTombstone(tombstone, record.revision, path);
	for (const historical of record.history) assertSnapshot(historical, path);
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

	async create(
		globalDirection: string,
		items: readonly TodoDefinition[],
		id: string = randomUUID(),
	): Promise<TodoListDocument> {
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
			const deletedIds = new Set(document.tombstones.map((entry) => entry.id));
			for (const item of items) {
				if (deletedIds.has(item.id)) {
					throw new TodoValidationError(`Todo "${item.id}" was deleted and its id cannot be reused`);
				}
			}
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
			return true;
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
			if (task.status === "in_progress" && patch.claim_token !== task.claim_token) {
				throw new TodoValidationError(`Todo "${taskId}" requires its current claim token for updates`);
			}
			if (patch.status === "in_progress" && task.status !== "in_progress") {
				throw new TodoValidationError(`Todo "${taskId}" must enter in_progress through todo_claim`);
			}
			if (task.status === "in_progress" && patch.status === "pending") {
				throw new TodoValidationError(`Todo "${taskId}" must return to pending through todo_release`);
			}
			if (patch.owner !== undefined && patch.owner !== task.owner) {
				throw new TodoValidationError(`Todo "${taskId}" ownership can change only through claim or release`);
			}
			if (patch.subject !== undefined) task.subject = patch.subject;
			if (patch.description !== undefined) task.description = patch.description?.trim() || undefined;
			if (patch.active_form !== undefined) task.active_form = patch.active_form?.trim() || undefined;
			if (patch.depends_on !== undefined) task.depends_on = [...patch.depends_on];
			if (patch.acceptance_criteria !== undefined) {
				task.acceptance_criteria = patch.acceptance_criteria?.map((criterion) => criterion.trim()) ?? undefined;
			}
			if (patch.status !== undefined) {
				task.status = patch.status;
				if (patch.status !== "in_progress") {
					task.owner = undefined;
					task.claim_token = undefined;
				}
			}
			validateDefinitions(definitions(document.tasks));
			task.updated_at = now;
			task.revision = document.revision + 1;
			return true;
		});
	}

	async claim(listId: string, taskId: string, owner: string, expectedRevision?: number): Promise<TodoClaim> {
		if (!owner.trim()) throw new TodoValidationError("Claim owner must not be empty");
		let claimToken = "";
		const list = await this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (expectedRevision !== undefined && task.revision !== expectedRevision) {
				throw new TodoValidationError(
					`Todo "${taskId}" revision changed from ${expectedRevision} to ${task.revision}`,
				);
			}
			if (task.status !== "pending")
				throw new TodoValidationError(`Todo "${taskId}" is ${task.status}, not pending`);
			const readyIds = new Set(getReadyTasks(document.tasks).map((candidate) => candidate.id));
			if (!readyIds.has(taskId)) throw new TodoValidationError(`Todo "${taskId}" is blocked by dependencies`);
			claimToken = randomUUID();
			task.status = "in_progress";
			task.owner = owner.trim();
			task.claim_token = claimToken;
			task.updated_at = now;
			task.revision = document.revision + 1;
			return true;
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
			return true;
		});
	}

	async transfer(listId: string, taskId: string, newOwner: string, claimToken: string): Promise<TodoListDocument> {
		if (!newOwner.trim()) throw new TodoValidationError("New claim owner must not be empty");
		return this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (task.status !== "in_progress" || task.claim_token !== claimToken) {
				throw new TodoValidationError(`Todo "${taskId}" claim token does not match an active claim`);
			}
			if (task.owner === newOwner) return false;
			task.owner = newOwner.trim();
			task.updated_at = now;
			task.revision = document.revision + 1;
			return true;
		});
	}

	async delete(listId: string, taskId: string): Promise<TodoListDocument> {
		return this.mutate(listId, (document, now) => {
			const task = requireTask(document, taskId);
			if (task.status === "in_progress")
				throw new TodoValidationError(`Todo "${taskId}" must be released before deletion`);
			document.tasks = document.tasks.filter((candidate) => candidate.id !== taskId);
			for (const candidate of document.tasks) {
				if (!candidate.depends_on.includes(taskId)) continue;
				candidate.depends_on = candidate.depends_on.filter((id) => id !== taskId);
				candidate.updated_at = now;
				candidate.revision = document.revision + 1;
			}
			document.tombstones.push({ id: taskId, deleted_at: now, revision: document.revision + 1 });
			validateDefinitions(definitions(document.tasks), true);
			return true;
		});
	}

	async clone(sourceId: string, revision?: number, targetId: string = randomUUID()): Promise<TodoListDocument> {
		const source = await this.read(sourceId, revision);
		return this.withLock(targetId, async () => {
			try {
				await readFile(this.documentPath(targetId));
				throw new TodoValidationError(`Todo list "${targetId}" already exists`);
			} catch (error) {
				if (error instanceof TodoValidationError) throw error;
				if (!isNotFound(error)) throw error;
			}
			const now = new Date().toISOString();
			const document: TodoListDocument = {
				...source,
				id: targetId,
				created_at: now,
				updated_at: now,
				tasks: source.tasks.map((task) => ({
					...cloneTask(task),
					status: task.status === "in_progress" ? "pending" : task.status,
					owner: undefined,
					claim_token: undefined,
					created_at: now,
					updated_at: now,
				})),
				history: [],
			};
			await this.writeDocument(document);
			return cloneDocument(document);
		});
	}

	async removeList(id: string): Promise<void> {
		await this.withLock(id, async () => rm(this.listDir(id), { recursive: true, force: true }));
	}

	private async mutate(
		id: string,
		operation: (document: TodoListDocument, now: string) => boolean,
	): Promise<TodoListDocument> {
		return this.withLock(id, async () => {
			const document = await this.readDocument(id);
			const previous = snapshot(document);
			const now = new Date().toISOString();
			if (operation(document, now) === false) return cloneDocument(document);
			document.history.push(previous);
			if (document.history.length > HISTORY_LIMIT)
				document.history.splice(0, document.history.length - HISTORY_LIMIT);
			document.revision++;
			document.updated_at = now;
			await this.writeDocument(document);
			return cloneDocument(document);
		});
	}

	private async readDocument(id: string): Promise<TodoListDocument> {
		validateListId(id);
		const path = this.documentPath(id);
		try {
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			assertDocument(value, path, id);
			validateDefinitions(definitions(value.tasks), true);
			return value;
		} catch (error) {
			if (isNotFound(error)) throw new TodoPersistenceError(`Todo list "${id}" does not exist`, { cause: error });
			const backupPath = this.backupPath(id);
			try {
				const backup = await readFile(backupPath, "utf8");
				const value: unknown = JSON.parse(backup);
				assertDocument(value, backupPath, id);
				validateDefinitions(definitions(value.tasks), true);
				await this.atomicWrite(path, backup);
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
			const previous = await readFile(path, "utf8");
			await this.atomicWrite(this.backupPath(document.id), previous);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		await this.atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`);
	}

	private async atomicWrite(path: string, content: string): Promise<void> {
		const directory = dirname(path);
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		const directoryHandle = await open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	}

	private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
		validateListId(id);
		await mkdir(join(this.rootDir, ".locks"), { recursive: true });
		const lockPath = join(this.rootDir, ".locks", `${id}.lock`);
		const ownerPath = join(lockPath, "owner.json");
		const nonce = randomUUID();
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		while (true) {
			try {
				await mkdir(lockPath);
				await this.atomicWrite(
					ownerPath,
					JSON.stringify({ pid: process.pid, host: hostname(), nonce, createdAt: new Date().toISOString() }),
				);
				break;
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				if (await isStaleLock(lockPath, ownerPath)) {
					await rm(lockPath, { recursive: true, force: true });
					continue;
				}
				if (Date.now() >= deadline) throw new TodoPersistenceError(`Timed out waiting for todo list "${id}" lock`);
				await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
			}
		}
		try {
			return await operation();
		} finally {
			try {
				const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
				if (typeof owner === "object" && owner !== null && (owner as Record<string, unknown>).nonce === nonce) {
					await rm(lockPath, { recursive: true, force: true });
				}
			} catch {
				// A missing or unreadable owner is left for bounded stale-lock recovery.
			}
		}
	}

	private listDir(id: string): string {
		validateListId(id);
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

function validateListId(id: string): void {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new TodoValidationError(`Invalid todo list id "${id}"`);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function assertTask(value: unknown, listRevision: number, path: string): asserts value is TodoTask {
	if (typeof value !== "object" || value === null) throw new TodoPersistenceError(`Malformed task in ${path}`);
	const task = value as Record<string, unknown>;
	if (
		typeof task.id !== "string" ||
		!TODO_ID_PATTERN.test(task.id) ||
		typeof task.subject !== "string" ||
		!task.subject.trim() ||
		(task.description !== undefined && typeof task.description !== "string") ||
		(task.active_form !== undefined && typeof task.active_form !== "string") ||
		!Array.isArray(task.depends_on) ||
		!task.depends_on.every((dependency) => typeof dependency === "string") ||
		(task.acceptance_criteria !== undefined &&
			(!Array.isArray(task.acceptance_criteria) ||
				!task.acceptance_criteria.every((criterion) => typeof criterion === "string" && criterion.trim()))) ||
		!TODO_STATUSES.includes(task.status as TodoStatus) ||
		!isTimestamp(task.created_at) ||
		!isTimestamp(task.updated_at) ||
		!isPositiveInteger(task.revision) ||
		task.revision > listRevision
	) {
		throw new TodoPersistenceError(`Malformed task in ${path}`);
	}
	const hasOwner = typeof task.owner === "string" && task.owner.length > 0;
	const hasToken = typeof task.claim_token === "string" && task.claim_token.length > 0;
	if (
		(task.status === "in_progress" && (!hasOwner || !hasToken)) ||
		(task.status !== "in_progress" && (hasOwner || hasToken))
	) {
		throw new TodoPersistenceError(`Inconsistent task ownership in ${path}`);
	}
}

function assertTombstone(value: unknown, listRevision: number, path: string): void {
	if (typeof value !== "object" || value === null) throw new TodoPersistenceError(`Malformed tombstone in ${path}`);
	const tombstone = value as Record<string, unknown>;
	if (
		typeof tombstone.id !== "string" ||
		!TODO_ID_PATTERN.test(tombstone.id) ||
		!isTimestamp(tombstone.deleted_at) ||
		!isPositiveInteger(tombstone.revision) ||
		tombstone.revision > listRevision
	) {
		throw new TodoPersistenceError(`Malformed tombstone in ${path}`);
	}
}

function assertSnapshot(value: unknown, path: string): void {
	if (typeof value !== "object" || value === null) throw new TodoPersistenceError(`Malformed history in ${path}`);
	const snapshotValue = value as Record<string, unknown>;
	if (
		!isPositiveInteger(snapshotValue.revision) ||
		typeof snapshotValue.global_direction !== "string" ||
		!Array.isArray(snapshotValue.tasks) ||
		!Array.isArray(snapshotValue.tombstones) ||
		!isTimestamp(snapshotValue.created_at) ||
		!isTimestamp(snapshotValue.updated_at)
	) {
		throw new TodoPersistenceError(`Malformed history in ${path}`);
	}
	for (const task of snapshotValue.tasks) assertTask(task, snapshotValue.revision, path);
	for (const tombstone of snapshotValue.tombstones) assertTombstone(tombstone, snapshotValue.revision, path);
}

async function isStaleLock(lockPath: string, ownerPath: string): Promise<boolean> {
	try {
		const raw: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
		if (typeof raw !== "object" || raw === null) return lockAgeExceeds(lockPath, FOREIGN_LOCK_STALE_MS);
		const owner = raw as Record<string, unknown>;
		if (owner.host === hostname() && typeof owner.pid === "number" && Number.isInteger(owner.pid)) {
			return !isProcessAlive(owner.pid);
		}
		return lockAgeExceeds(lockPath, FOREIGN_LOCK_STALE_MS);
	} catch (error) {
		if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error;
		return lockAgeExceeds(lockPath, FOREIGN_LOCK_STALE_MS);
	}
}

async function lockAgeExceeds(lockPath: string, ageMs: number): Promise<boolean> {
	try {
		return Date.now() - (await stat(lockPath)).mtimeMs > ageMs;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}
