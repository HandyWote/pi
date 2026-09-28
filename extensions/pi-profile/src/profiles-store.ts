import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileSync, readTextFileIfExists } from "./atomic-write.ts";
import { normalizePath } from "./paths.ts";
import type { ProfilesStateFile } from "./profiles-state-file.ts";
import type { Profile } from "./profiles-types.ts";

// TODO(upstream-migration): replace with getAgentDir()/CONFIG_DIR_NAME from
// @earendil-works/pi-coding-agent once the extension resolves the official
// package at runtime (loader aliasing).
const CONFIG_DIR_NAME = ".pi";
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return normalizePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Absolute path of the profile management state file (the source of truth). */
export function getProfileStatePath(): string {
	return join(getAgentDir(), "profile-state.json");
}

function createEmptyFile(): ProfilesStateFile {
	return { version: 1, profiles: {}, managedProviderIds: [] };
}

/**
 * Durable store for profile management state (`profile-state.json`).
 *
 * All writes are atomic (temp file + rename). Profiles are keyed by their
 * stable profile ID; there is no active-profile concept here (model choice
 * happens through the official /model entry).
 */
export class ProfilesStore {
	private path: string;

	constructor(profilesPath?: string) {
		this.path = normalizePath(profilesPath ?? getProfileStatePath());
	}

	private ensureDir(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFile(): void {
		if (!existsSync(this.path)) {
			atomicWriteFileSync(this.path, JSON.stringify(createEmptyFile(), null, 2));
		}
	}

	/**
	 * In-process advisory lock guarding read-modify-write cycles. Concurrency
	 * across separate pi processes is bounded by Node's single-threaded
	 * execution plus the short critical sections.
	 */
	private withLock<T>(fn: () => T): T {
		return fn();
	}

	private read(): ProfilesStateFile {
		this.ensureDir();
		this.ensureFile();
		return this.withLock(() => JSON.parse(readTextFileIfExists(this.path) ?? "") as ProfilesStateFile);
	}

	private write(fn: (data: ProfilesStateFile) => ProfilesStateFile): ProfilesStateFile {
		this.ensureDir();
		this.ensureFile();
		return this.withLock(() => {
			const data = JSON.parse(readTextFileIfExists(this.path) ?? "") as ProfilesStateFile;
			const next = fn(data);
			// Atomic tmp+rename: a crash never leaves a truncated state file.
			atomicWriteFileSync(this.path, JSON.stringify(next, null, 2));
			return next;
		});
	}

	list(): readonly Profile[] {
		return Object.values(this.read().profiles);
	}

	get(id: string): Profile | undefined {
		return this.read().profiles[id];
	}

	create(profile: Profile): Profile {
		return this.write((data) => {
			if (data.profiles[profile.id]) {
				throw new Error(`Profile with id "${profile.id}" already exists`);
			}
			return { ...data, profiles: { ...data.profiles, [profile.id]: profile } };
		}).profiles[profile.id]!;
	}

	update(id: string, fn: (profile: Profile) => Profile): Profile {
		return this.write((data) => {
			const existing = data.profiles[id];
			if (!existing) throw new Error(`Profile "${id}" not found`);
			return { ...data, profiles: { ...data.profiles, [id]: fn(existing) } };
		}).profiles[id]!;
	}

	upsert(profile: Profile): Profile {
		return this.write((data) => ({
			...data,
			profiles: { ...data.profiles, [profile.id]: profile },
		})).profiles[profile.id]!;
	}

	delete(id: string): void {
		this.write((data) => {
			if (!data.profiles[id]) throw new Error(`Profile "${id}" not found`);
			const profiles = { ...data.profiles };
			delete profiles[id];
			return { ...data, profiles };
		});
	}

	/** Provider IDs written into models.json by the last profile compile. */
	getManagedProviderIds(): string[] {
		return [...(this.read().managedProviderIds ?? [])];
	}

	/** Record the provider IDs the latest compile wrote into models.json. */
	setManagedProviderIds(ids: readonly string[]): void {
		this.write((data) => ({ ...data, managedProviderIds: [...ids] }));
	}
}
