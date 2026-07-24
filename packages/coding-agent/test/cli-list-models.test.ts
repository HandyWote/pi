import type { Api, Model } from "@handy_wote/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { Profile, UserModel } from "../src/core/profiles-types.ts";

const PROFILE_KEY = "sk-profile-secret";
const PROFILE_URL = "https://gateway.example/private?api_key=url-secret";

function profile(id: string, name: string, overrides: Partial<Profile> = {}): Profile {
	return {
		id,
		name,
		protocol: "openai",
		baseUrl: PROFILE_URL,
		apiKey: PROFILE_KEY,
		models: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function model(provider: string, id: string, name: string): Model<Api> {
	return {
		id,
		name,
		provider,
		api: "openai-responses",
		baseUrl: PROFILE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function disabledProfileModel(id: string): UserModel {
	return {
		id,
		name: id,
		enabled: false,
		contextWindow: 128_000,
		maxTokens: 16_384,
		supportsReasoning: false,
		supportsVision: false,
		supportsToolCall: false,
		metadataSource: "default",
	};
}

function runtime(
	models: readonly Model<Api>[],
	profiles: readonly Profile[],
	activeProfileId?: string,
	error?: string,
): ModelRuntime {
	const names = new Map(profiles.map((entry) => [entry.id, entry.name]));
	return {
		getError: () => error,
		getModels: () => models,
		getProfiles: () => profiles,
		getActiveProfile: () => profiles.find((entry) => entry.id === activeProfileId),
		getProviderName: (providerId: string) => names.get(providerId) ?? providerId,
	} as unknown as ModelRuntime;
}

async function captureList(
	runtimeValue: ModelRuntime,
	searchPattern?: string,
): Promise<{ stdout: string; stderr: string }> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await listModels(runtimeValue, searchPattern);
		return {
			stdout: logSpy.mock.calls.map(([line]) => String(line)).join("\n"),
			stderr: errorSpy.mock.calls.map(([line]) => String(line)).join("\n"),
		};
	} finally {
		errorSpy.mockRestore();
		logSpy.mockRestore();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("--list-models output", () => {
	it("lists models from multiple Profiles with active, profile, and reference columns", async () => {
		const profiles = [profile("alpha", "Alpha Gateway"), profile("beta", "Beta Gateway")];
		const { stdout } = await captureList(
			runtime(
				[model("alpha", "shared-model", "Shared Model"), model("beta", "shared-model", "Shared Model")],
				profiles,
				"alpha",
			),
		);

		const lines = stdout.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("active");
		expect(lines[0]).toContain("profile");
		expect(lines[0]).toContain("reference");
		expect(lines[1]).toMatch(/\*\s+Alpha Gateway\s+shared-model\s+alpha\/shared-model/);
		expect(lines[2]).toMatch(/\s+Beta Gateway\s+shared-model\s+beta\/shared-model/);
	});

	it("searches by Profile name and provider/model reference", async () => {
		const profiles = [profile("alpha", "Alpha Gateway"), profile("beta", "Beta Gateway")];
		const models = [model("alpha", "alpha-model", "Alpha Model"), model("beta", "beta-model", "Beta Model")];

		const { stdout: byProfileName } = await captureList(runtime(models, profiles), "Beta Gateway");
		expect(byProfileName).toContain("Beta Gateway");
		expect(byProfileName).toContain("beta/beta-model");
		expect(byProfileName).not.toContain("alpha/alpha-model");

		const { stdout: byReference } = await captureList(runtime(models, profiles), "beta/beta-model");
		expect(byReference).toContain("beta/beta-model");
		expect(byReference).not.toContain("alpha/alpha-model");
	});

	it("explains how to configure Profiles when no models are selectable", async () => {
		expect((await captureList(runtime([], []))).stdout).toContain("No profiles configured. Use /profile");

		const output = await captureList(
			runtime([], [profile("alpha", "Alpha Gateway", { models: [disabledProfileModel("disabled-model")] })]),
		);
		expect(output.stdout).toContain("No selectable models. Enable a model in /profile");
		expect(output.stdout).toContain("Alpha Gateway");
		expect(output.stdout).toContain("disabled");
	});

	it("does not expose Profile keys or URLs", async () => {
		const output = await captureList(
			runtime(
				[model("alpha", "alpha-model", "Alpha Model")],
				[profile("alpha", "Alpha Gateway")],
				"alpha",
				"model refresh warning",
			),
		);

		const combined = `${output.stdout}\n${output.stderr}`;
		expect(combined).not.toContain(PROFILE_KEY);
		expect(combined).not.toContain(PROFILE_URL);
		expect(output.stderr).toContain("Warning: model runtime errors:");
	});
});
