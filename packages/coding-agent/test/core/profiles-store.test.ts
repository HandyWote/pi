import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilesStore } from "../../src/core/profiles-store.ts";
import type { Profile } from "../../src/core/profiles-types.ts";

function makeProfile(id: string, name: string): Profile {
	return {
		id,
		name,
		protocol: "openai",
		baseUrl: "https://example.com/v1",
		apiKey: "sk-test",
		models: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("ProfilesStore", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "profiles-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty list for new store", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		expect(store.list()).toEqual([]);
	});

	it("creates and retrieves a profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		const profile = makeProfile("a", "Profile A");
		store.create(profile);
		expect(store.list()).toHaveLength(1);
		expect(store.get("a")).toEqual(profile);
	});

	it("throws on duplicate id", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		store.create(makeProfile("a", "A"));
		expect(() => store.create(makeProfile("a", "A2"))).toThrow("already exists");
	});

	it("updates a profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		store.create(makeProfile("a", "A"));
		store.update("a", (p) => ({ ...p, name: "Renamed" }));
		expect(store.get("a")?.name).toBe("Renamed");
	});

	it("preserves API routes through updates and JSON round-trips", () => {
		const file = join(tmpDir, "profiles.json");
		const routes = {
			"openai-completions": { sdkBaseUrl: "https://example.com/v1" },
			"anthropic-messages": { sdkBaseUrl: "https://example.com", verified: false },
		} as const;
		const store = new ProfilesStore(file);
		store.create({ ...makeProfile("a", "A"), apiRoutes: routes });

		store.update("a", (p) => ({ ...p, name: "Renamed" }));

		const reloaded = new ProfilesStore(file).get("a");
		expect(reloaded?.apiRoutes).toEqual(routes);
	});

	it("throws on update of non-existent profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		expect(() => store.update("nope", (p) => p)).toThrow("not found");
	});

	it("deletes a profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		store.create(makeProfile("a", "A"));
		store.create(makeProfile("b", "B"));
		store.delete("a");
		expect(store.list()).toHaveLength(1);
		expect(store.get("a")).toBeUndefined();
		expect(store.get("b")).toBeDefined();
	});

	it("clears active when deleting active profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		store.create(makeProfile("a", "A"));
		store.setActive("a");
		expect(store.getActive()?.id).toBe("a");
		store.delete("a");
		expect(store.getActive()).toBeUndefined();
	});

	it("throws on delete of non-existent profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		expect(() => store.delete("nope")).toThrow("not found");
	});

	it("sets and gets active profile", () => {
		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		store.create(makeProfile("a", "A"));
		store.setActive("a");
		expect(store.getActive()?.id).toBe("a");
		store.setActive(undefined);
		expect(store.getActive()).toBeUndefined();
	});

	it("data persists across store instances", () => {
		const file = join(tmpDir, "profiles.json");
		const store1 = new ProfilesStore(file);
		store1.create(makeProfile("a", "A"));
		store1.setActive("a");

		const store2 = new ProfilesStore(file);
		expect(store2.list()).toHaveLength(1);
		expect(store2.getActive()?.id).toBe("a");
	});

	it("retries transient lock contention", () => {
		const lockSync = lockfile.lockSync.bind(lockfile);
		let attempts = 0;
		vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
			attempts++;
			if (attempts < 3) throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
			return lockSync(path, options);
		});

		const store = new ProfilesStore(join(tmpDir, "profiles.json"));
		expect(store.list()).toEqual([]);
		expect(attempts).toBe(3);
	});
});
