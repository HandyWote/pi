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
		expect(runtime.getProviderName("test-profile")).toBe("Test test-profile");
		expect(runtime.isProfileProvider("test-profile")).toBe(true);
		runtime.registerProvider("extension-provider", {
			name: "Extension Provider",
			baseUrl: "https://extension.example/v1",
			api: "openai-completions",
		});
		expect(runtime.getProviderName("extension-provider")).toBe("Extension Provider");
		expect(runtime.isProfileProvider("extension-provider")).toBe(false);
		expect(runtime.getProviderName("missing-provider")).toBe("missing-provider");
		expect(runtime.isProfileProvider("missing-provider")).toBe(false);

		const models = runtime.getModels("test-profile");
		expect(models).toHaveLength(2);
		expect(models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
	});

	it("keeps models with different APIs in one profile provider", async () => {
		const runtime = await ModelRuntime.create({
			profilesPath: join(tmpDir, "profiles.json"),
			modelsStorePath: undefined,
		});
		const base = makeTestProfile("gateway", []);
		await runtime.createProfile({
			...base,
			protocol: undefined,
			models: [
				{
					...makeTestProfile("unused", [{ id: "gpt", name: "GPT" }]).models[0],
					apiPreference: "openai-responses",
				},
				{
					...makeTestProfile("unused", [{ id: "claude", name: "Claude" }]).models[0],
					apiPreference: "anthropic-messages",
				},
			],
		});

		expect(runtime.getProviders()).toHaveLength(1);
		expect(runtime.getModels("gateway").map((model) => [model.id, model.api])).toEqual([
			["gpt", "openai-responses"],
			["claude", "anthropic-messages"],
		]);
	});

	it("keeps resolvable models when another enabled model needs an API choice", async () => {
		const runtime = await ModelRuntime.create({ profilesPath: join(tmpDir, "profiles.json") });
		const next = makeTestProfile("gateway", [
			{ id: "working", name: "Working" },
			{ id: "unresolved", name: "Unresolved" },
		]);
		next.protocol = undefined;
		next.models[0].apiPreference = "openai-completions";

		await runtime.createProfile(next);

		expect(runtime.getModels("gateway").map((model) => model.id)).toEqual(["working"]);
		expect(runtime.getError()).toContain("model unresolved");
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
