import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import type { Profile } from "../../src/core/profiles-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

function registry(contextWindow: number) {
	return {
		version: 1,
		families: [],
		models: [{ id: "reload-model", metadata: { contextWindow } }],
	};
}

describe("AgentSession compat registry reload", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-agent-session-registry-reload-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reloads settings descriptors, registry files, providers, and the current model", async () => {
		const firstRegistryPath = join(agentDir, "first-registry.json");
		const secondRegistryPath = join(agentDir, "second-registry.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(firstRegistryPath, JSON.stringify(registry(100_000)));
		writeFileSync(secondRegistryPath, JSON.stringify(registry(200_000)));
		writeFileSync(
			settingsPath,
			JSON.stringify({ compatRegistries: [{ type: "file", path: "first-registry.json" }] }),
		);

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const modelRuntime = await ModelRuntime.create({
			profilesPath: join(agentDir, "profiles.json"),
			compatRegistries: settingsManager.getCompatRegistries(),
		});
		const profile: Profile = {
			id: "reload-profile",
			name: "Reload Profile",
			baseUrl: "https://gateway.invalid/v1",
			apiKey: "test-key",
			models: [
				{
					id: "reload-model",
					name: "Reload Model",
					enabled: true,
					contextWindow: 50_000,
					maxTokens: 8_000,
					supportsReasoning: false,
					supportsVision: false,
					supportsToolCall: true,
					metadataSource: "default",
					apiPreference: "openai-completions",
					available: true,
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		await modelRuntime.createProfile(profile);
		const initialModel = modelRuntime.getModel(profile.id, "reload-model");
		expect(initialModel?.contextWindow).toBe(100_000);

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: initialModel,
		});

		try {
			writeFileSync(
				settingsPath,
				JSON.stringify({ compatRegistries: [{ type: "file", path: "second-registry.json" }] }),
			);
			await session.reload();

			expect(settingsManager.getCompatRegistries()).toEqual([
				{ type: "file", path: "second-registry.json", baseDir: agentDir },
			]);
			expect(modelRuntime.getModel(profile.id, "reload-model")?.contextWindow).toBe(200_000);
			expect(session.model?.contextWindow).toBe(200_000);
		} finally {
			session.dispose();
		}
	});
});
