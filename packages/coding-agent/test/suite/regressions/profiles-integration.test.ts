import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import type { Profile } from "../../../src/core/profiles-types.ts";

function makeTestProfile(id: string, models: Array<{ id: string; name: string }>): Profile {
	return {
		id,
		name: `Test ${id}`,
		protocol: "openai" as const,
		baseUrl: "https://example.com/v1",
		apiKey: "sk-test",
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			enabled: true,
			contextWindow: 128000,
			maxTokens: 16384,
			supportsReasoning: false,
			supportsVision: false,
			supportsToolCall: true,
			metadataSource: "manual" as const,
		})),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("Profile-based ModelRuntime", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "profiles-integration-"));
	});

	afterEach(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("creates providers from profiles", async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(tmpDir, "auth.json"),
			profilesPath: join(tmpDir, "profiles.json"),
			modelsStorePath: undefined,
		});

		const profile = makeTestProfile("test-profile", [
			{ id: "model-a", name: "Model A" },
			{ id: "model-b", name: "Model B" },
		]);

		await runtime.createProfile(profile);

		const providers = runtime.getProviders();
		expect(providers).toHaveLength(1);
		expect(providers[0].id).toBe("test-profile");

		const models = runtime.getModels("test-profile");
		expect(models).toHaveLength(2);
		expect(models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
	});

	it("lists profiles", async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(tmpDir, "auth.json"),
			profilesPath: join(tmpDir, "profiles.json"),
			modelsStorePath: undefined,
		});

		await runtime.createProfile(makeTestProfile("a", [{ id: "m1", name: "M1" }]));
		await runtime.createProfile(makeTestProfile("b", [{ id: "m2", name: "M2" }]));

		const profiles = runtime.getProfiles();
		expect(profiles).toHaveLength(2);
	});

	it("deletes profiles", async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(tmpDir, "auth.json"),
			profilesPath: join(tmpDir, "profiles.json"),
			modelsStorePath: undefined,
		});

		await runtime.createProfile(makeTestProfile("a", [{ id: "m1", name: "M1" }]));
		await runtime.createProfile(makeTestProfile("b", [{ id: "m2", name: "M2" }]));
		await runtime.deleteProfile("a");

		expect(runtime.getProfiles()).toHaveLength(1);
		expect(runtime.getProviders()).toHaveLength(1);
	});

	it("sets and gets active profile", async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(tmpDir, "auth.json"),
			profilesPath: join(tmpDir, "profiles.json"),
			modelsStorePath: undefined,
		});

		await runtime.createProfile(makeTestProfile("a", [{ id: "m1", name: "M1" }]));
		runtime.setActiveProfile("a");

		const active = runtime.getActiveProfile();
		expect(active?.id).toBe("a");
	});

	it("handles empty state gracefully", async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(tmpDir, "auth.json"),
			profilesPath: join(tmpDir, "profiles.json"),
			modelsStorePath: undefined,
		});

		expect(runtime.getProfiles()).toEqual([]);
		expect(runtime.getProviders()).toEqual([]);
		expect(runtime.getActiveProfile()).toBeUndefined();
	});
});
