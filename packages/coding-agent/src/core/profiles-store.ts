import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getProfilesPath } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { Profile, ProfilesFile } from "./profiles-types.ts";

const FILE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

function createEmptyFile(): ProfilesFile {
	return { profiles: [] };
}

export class ProfilesStore {
	private path: string;

	constructor(profilesPath?: string) {
		this.path = normalizePath(profilesPath ?? getProfilesPath());
	}

	private ensureDir(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFile(): void {
		if (!existsSync(this.path)) {
			writeFileSync(this.path, JSON.stringify(createEmptyFile(), null, 2), FILE_OPTIONS);
			chmodSync(this.path, 0o600);
		}
	}

	private acquireLockSyncWithRetry(): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(this.path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) throw error;

				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// ProfilesStore is synchronous, so retry with a short bounded wait.
				}
			}
		}

		throw new Error("Failed to acquire profiles lock");
	}

	private read(): ProfilesFile {
		this.ensureDir();
		this.ensureFile();
		const lock = this.acquireLockSyncWithRetry();
		try {
			return JSON.parse(readFileSync(this.path, "utf-8")) as ProfilesFile;
		} finally {
			lock();
		}
	}

	private write(fn: (data: ProfilesFile) => ProfilesFile): ProfilesFile {
		this.ensureDir();
		this.ensureFile();
		const lock = this.acquireLockSyncWithRetry();
		try {
			const data = JSON.parse(readFileSync(this.path, "utf-8")) as ProfilesFile;
			const next = fn(data);
			writeFileSync(this.path, JSON.stringify(next, null, 2), FILE_OPTIONS);
			chmodSync(this.path, 0o600);
			return next;
		} finally {
			lock();
		}
	}

	list(): readonly Profile[] {
		return this.read().profiles;
	}

	get(id: string): Profile | undefined {
		return this.read().profiles.find((p) => p.id === id);
	}

	create(profile: Profile): Profile {
		return this.write((data) => {
			if (data.profiles.some((p) => p.id === profile.id)) {
				throw new Error(`Profile with id "${profile.id}" already exists`);
			}
			return { ...data, profiles: [...data.profiles, profile] };
		}).profiles.find((p) => p.id === profile.id)!;
	}

	update(id: string, fn: (profile: Profile) => Profile): Profile {
		return this.write((data) => {
			const idx = data.profiles.findIndex((p) => p.id === id);
			if (idx === -1) throw new Error(`Profile "${id}" not found`);
			const updated = fn(data.profiles[idx]);
			const profiles = [...data.profiles];
			profiles[idx] = updated;
			return { ...data, profiles };
		}).profiles.find((p) => p.id === id)!;
	}

	delete(id: string): void {
		this.write((data) => {
			const idx = data.profiles.findIndex((p) => p.id === id);
			if (idx === -1) throw new Error(`Profile "${id}" not found`);
			const profiles = [...data.profiles];
			profiles.splice(idx, 1);
			return {
				...data,
				profiles,
				activeProfileId: data.activeProfileId === id ? undefined : data.activeProfileId,
			};
		});
	}

	getActive(): Profile | undefined {
		const data = this.read();
		return data.activeProfileId ? data.profiles.find((p) => p.id === data.activeProfileId) : undefined;
	}

	setActive(id: string | undefined): void {
		this.write((data) => ({ ...data, activeProfileId: id }));
	}
}
