import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "../src/atomic-write.ts";
import { createProfileDraft, saveProfile } from "../src/command.ts";
import {
	compileProfiles,
	isValidProviderId,
	mergeIntoModelsJson,
	normalizeBaseUrl,
	normalizeModelCost,
	selectModelApi,
	serializeModelsJson,
} from "../src/compiler.ts";
import { discoverProfile } from "../src/profile-discovery.ts";
import { compileAndWriteModelsJson, toCompilerProfileInput } from "../src/profile-manager.ts";
import { ProfilesStore } from "../src/profiles-store.ts";
import type { Profile, UserModel } from "../src/profiles-types.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-profile-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeModel(partial: Partial<UserModel> & { id: string }): UserModel {
	return {
		name: partial.id,
		enabled: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		supportsReasoning: false,
		supportsVision: false,
		metadataSource: "default",
		...partial,
	};
}

function makeProfile(partial: Partial<Profile> & { id: string }): Profile {
	const now = new Date().toISOString();
	return {
		name: partial.id,
		baseUrl: "https://gw.example.com",
		authReference: { authProviderId: partial.id },
		models: [],
		createdAt: now,
		updatedAt: now,
		...partial,
	};
}

describe("ProfilesStore atomic writes", () => {
	it("creates, lists, updates, and deletes profiles in profile-state.json", () => {
		const store = new ProfilesStore(join(dir, "agent", "profile-state.json"));
		const profile = makeProfile({ id: "p1" });
		store.create(profile);
		expect(store.list().map((p) => p.id)).toEqual(["p1"]);
		expect(store.get("p1")?.name).toBe("p1");

		store.update("p1", (p) => ({ ...p, name: "renamed" }));
		expect(store.get("p1")?.name).toBe("renamed");

		store.delete("p1");
		expect(store.get("p1")).toBeUndefined();
	});

	it("writes state atomically: no temp files remain after a save", () => {
		const statePath = join(dir, "agent", "profile-state.json");
		const store = new ProfilesStore(statePath);
		store.upsert(makeProfile({ id: "p1" }));
		expect(JSON.parse(readFileSync(statePath, "utf-8")).version).toBe(1);
		const siblings = readdirSync(join(dir, "agent"));
		expect(siblings.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("rejects duplicate create with a stable error", () => {
		const store = new ProfilesStore(join(dir, "profile-state.json"));
		store.create(makeProfile({ id: "dup" }));
		expect(() => store.create(makeProfile({ id: "dup" }))).toThrow(/already exists/);
	});
});

describe("atomicWriteFileSync", () => {
	it("leaves no temp files and preserves prior content on write", () => {
		const filePath = join(dir, "nested", "file.json");
		atomicWriteFileSync(filePath, '{"a":1}\n');
		expect(readFileSync(filePath, "utf-8")).toBe('{"a":1}\n');
		atomicWriteFileSync(filePath, '{"a":2}\n');
		expect(readFileSync(filePath, "utf-8")).toBe('{"a":2}\n');
		const leftovers = readdirSync(join(dir, "nested")).filter((name) => name.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});
});

describe("compiler field mapping", () => {
	it("maps supportsReasoning/supportsVision to reasoning/input", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "vendor/model-a",
						name: "Model A",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
						supportsReasoning: true,
						supportsVision: true,
					},
					{
						id: "vendor/model-b",
						name: "Model B",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
						supportsReasoning: false,
						supportsVision: false,
					},
				],
			},
		]);
		const models = doc.providers.gw.models;
		expect(models).toHaveLength(2);
		const modelA = models.find((m) => m.id === "vendor/model-a")!;
		const modelB = models.find((m) => m.id === "vendor/model-b")!;
		expect(modelA.reasoning).toBe(true);
		expect(modelA.compat).toEqual({ supportsDeveloperRole: false });
		expect(modelA.input).toEqual(["text", "image"]);
		expect(modelB.reasoning).toBe(false);
		expect(modelB.input).toEqual(["text"]);
	});

	it("applies overrides with the profile-state vocabulary", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "m1",
						name: "M1",
						enabled: true,
						supportsReasoning: false,
						supportsVision: false,
						apiRoutes: { "anthropic-messages": { sdkBaseUrl: "https://gw.example.com" } },
						overrides: { supportsReasoning: true, supportsVision: true, contextWindow: 200_000 },
					},
				],
			},
		]);
		const entry = doc.providers.gw.models[0];
		expect(entry.reasoning).toBe(true);
		expect(entry.input).toEqual(["text", "image"]);
		expect(entry.contextWindow).toBe(200_000);
	});

	it("excludes disabled and unavailable models", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "on",
						name: "on",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
					},
					{ id: "off", name: "off", enabled: false },
					{ id: "gone", name: "gone", enabled: true, available: false },
				],
			},
		]);
		expect(doc.providers.gw.models.map((m) => m.id)).toEqual(["on"]);
	});

	it("preserves raw gateway model IDs verbatim", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "anthropic/claude-sonnet-4.6",
						name: "Claude",
						enabled: true,
						apiRoutes: { "anthropic-messages": { sdkBaseUrl: "https://gw.example.com" } },
					},
				],
			},
		]);
		expect(doc.providers.gw.models[0].id).toBe("anthropic/claude-sonnet-4.6");
	});

	it("compiles the standard /v1 API route from a gateway root", () => {
		const { doc, diagnostics } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "m1",
						name: "M1",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com/v1" } },
					},
				],
			},
		]);
		expect(diagnostics).toEqual([]);
		expect(doc.providers.gw.baseUrl).toBe("https://gw.example.com/v1");
	});

	it("skips models whose route belongs to another gateway", () => {
		const { doc, diagnostics } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "m1",
						name: "M1",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://other.example.com/v1" } },
					},
				],
			},
		]);
		expect(doc.providers.gw).toBeUndefined();
		expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("not the profile baseUrl"))).toBe(
			true,
		);
	});
});

describe("selectModelApi", () => {
	const routes = {
		"openai-completions": { sdkBaseUrl: "https://gw.example.com" },
		"anthropic-messages": { sdkBaseUrl: "https://gw.example.com" },
	};

	it("prefers model over family over gateway over profile", () => {
		const model = { apiRoutes: routes, apiPreference: "anthropic-messages" };
		expect(selectModelApi(model).api).toBe("anthropic-messages");
		expect(selectModelApi({ apiRoutes: routes }, "fam").api).toBeUndefined();
		expect(
			selectModelApi({ apiRoutes: routes, familyApiPreferences: { fam: "openai-completions" } }, "fam").api,
		).toBe("openai-completions");
		expect(selectModelApi({ apiRoutes: routes, profileApiPreference: "openai-completions" }).api).toBe(
			"openai-completions",
		);
	});

	it("falls back to the single usable route", () => {
		const single = { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } };
		expect(selectModelApi({ apiRoutes: single }).source).toBe("available");
		expect(selectModelApi({ apiRoutes: single }).api).toBe("openai-completions");
		expect(selectModelApi({ apiRoutes: routes }).source).toBe("unresolved-ambiguous");
	});
});

describe("normalizeBaseUrl / merge", () => {
	it("normalizes trailing slashes, default ports, and host case", () => {
		expect(normalizeBaseUrl("https://GW.example.com:443/v1/")).toBe("https://gw.example.com/v1");
		expect(normalizeBaseUrl("https://gw.example.com")).toBe(normalizeBaseUrl("https://gw.example.com/"));
	});

	it("mergeIntoModelsJson preserves non-profile providers and replaces by key", () => {
		const existing = { providers: { builtin: { name: "B" }, gw: { name: "OLD" } } };
		const compiled = compileProfiles([
			{
				id: "gw",
				name: "NEW",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "m",
						name: "m",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
					},
				],
			},
		]).doc;
		const merged = mergeIntoModelsJson(existing, compiled);
		expect(Object.keys(merged.providers).sort()).toEqual(["builtin", "gw"]);
		expect((merged.providers.gw as { name: string }).name).toBe("NEW");
	});

	it("serializes with a trailing newline", () => {
		const text = serializeModelsJson({ providers: {} });
		expect(text.endsWith("\n")).toBe(true);
	});
});

describe("saveProfile end-to-end: state then compiled models.json", () => {
	it("writes profile-state.json and atomically compiles models.json", () => {
		const agentDir = join(dir, "agent");
		const statePath = join(agentDir, "profile-state.json");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(statePath);

		const draft = createProfileDraft("Gateway", "https://gw.example.com", "gateway");
		draft.models = [
			makeModel({
				id: "vendor/model-x",
				availableApis: ["openai-completions"],
				apiPreference: "openai-completions",
			}),
		];
		const { profile, diagnostics } = saveProfile(store, draft, modelsPath);
		expect(profile.id).toBe(draft.id);
		expect(diagnostics).toEqual([]);

		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(state.profiles[profile.id].name).toBe("Gateway");
		expect(state.profiles[profile.id].authReference.authProviderId).toBe("gateway");

		const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		const provider = modelsJson.providers[profile.id];
		expect(provider.baseUrl).toBe("https://gw.example.com");
		expect(provider.apiKey).toBeUndefined(); // auth.json reference: no plaintext key
		expect(provider.models[0].id).toBe("vendor/model-x");
		expect(provider.models[0].input).toEqual(["text"]);

		expect(readdirSync(agentDir).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("compiles profile-level apiRoutes into models.json without per-model preference", () => {
		const agentDir = join(dir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));

		const draft = createProfileDraft("Gateway", "https://gw.example.com", "gateway");
		draft.apiRoutes = {
			"openai-completions": { sdkBaseUrl: "https://gw.example.com", verified: true },
		};
		draft.models = [makeModel({ id: "vendor/model-x", availableApis: ["openai-completions"] })];
		const { profile, diagnostics } = saveProfile(store, draft, modelsPath);
		expect(diagnostics).toEqual([]);

		const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		const provider = modelsJson.providers[profile.id];
		expect(provider).toBeDefined();
		expect(provider.models.map((m: { id: string }) => m.id)).toEqual(["vendor/model-x"]);
		expect(provider.models[0].api).toBe("openai-completions");
	});

	it("filters non-compilable APIs out of profile apiRoutes", () => {
		const agentDir = join(dir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));

		const draft = createProfileDraft("Gateway", "https://gw.example.com", "gateway");
		draft.apiRoutes = {
			"google-generative-ai": { sdkBaseUrl: "https://gw.example.com" },
		};
		draft.models = [makeModel({ id: "vendor/model-x" })];
		const { diagnostics } = saveProfile(store, draft, modelsPath);

		// google-generative-ai is not compilable: the model has no configured
		// compilable route, so it is skipped with a warning.
		expect(
			diagnostics.some((d) => d.severity === "warning" && d.message.includes("no configured compilable API route")),
		).toBe(true);
		const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(modelsJson.providers).toEqual({});
	});

	it("updating a profile recompiles models.json in place", () => {
		const agentDir = join(dir, "agent");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));
		const draft = createProfileDraft("G", "https://gw.example.com", "g");
		const { profile } = saveProfile(store, draft, join(agentDir, "models.json"));

		const enabled = makeModel({
			id: "m1",
			availableApis: ["anthropic-messages"],
			apiPreference: "anthropic-messages",
			supportsReasoning: true,
		});
		store.update(profile.id, (p) => ({ ...p, models: [enabled] }));
		compileAndWriteModelsJson(store, join(agentDir, "models.json"));

		const modelsJson = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8"));
		expect(modelsJson.providers[profile.id].models).toHaveLength(1);
		expect(modelsJson.providers[profile.id].models[0].reasoning).toBe(true);
	});

	it("store.delete followed by recompile removes the provider from models.json", () => {
		const agentDir = join(dir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));
		const draft = createProfileDraft("G", "https://gw.example.com", "g");
		draft.apiRoutes = {
			"openai-completions": { sdkBaseUrl: "https://gw.example.com", verified: true },
		};
		draft.models = [makeModel({ id: "vendor/model-x", availableApis: ["openai-completions"] })];
		const { profile } = saveProfile(store, draft, modelsPath);

		let modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(modelsJson.providers[profile.id]).toBeDefined();
		expect(modelsJson.providers[profile.id].models.map((m: { id: string }) => m.id)).toEqual(["vendor/model-x"]);

		store.delete(profile.id);
		const diagnostics = compileAndWriteModelsJson(store, modelsPath);
		expect(diagnostics).toEqual([]);
		modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(modelsJson.providers[profile.id]).toBeUndefined();
	});

	it("recompile keeps non-profile providers while dropping deleted profile providers", () => {
		const agentDir = join(dir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));
		const draft = createProfileDraft("G", "https://gw.example.com", "g");
		draft.apiRoutes = {
			"openai-completions": { sdkBaseUrl: "https://gw.example.com", verified: true },
		};
		draft.models = [makeModel({ id: "vendor/model-x", availableApis: ["openai-completions"] })];
		const { profile } = saveProfile(store, draft, modelsPath);

		// Simulate a hand-added (non-profile) provider alongside the profile one.
		const withBuiltin = JSON.parse(readFileSync(modelsPath, "utf-8"));
		withBuiltin.providers.builtin = { name: "Built-in override", baseUrl: "https://api.example.com" };
		atomicWriteFileSync(modelsPath, `${JSON.stringify(withBuiltin, null, 2)}\n`);

		store.delete(profile.id);
		compileAndWriteModelsJson(store, modelsPath);

		const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(modelsJson.providers[profile.id]).toBeUndefined();
		expect(modelsJson.providers.builtin).toBeDefined();
	});
});

describe("official models.json schema shape", () => {
	it("does not emit a non-official provider type field or a model-level baseUrl", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "m",
						name: "M",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
					},
				],
			},
		]);
		const provider = doc.providers.gw as Record<string, unknown>;
		expect(provider.type).toBeUndefined();
		expect(provider.models).toBeDefined();
		const entry = (provider.models as Array<Record<string, unknown>>)[0];
		expect(entry).not.toHaveProperty("baseUrl");
	});

	it("emits a complete cost object when cost is absent or partial", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "a",
						name: "A",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
					},
					{
						id: "b",
						name: "B",
						enabled: true,
						cost: { input: 1 },
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
					},
				],
			},
		]);
		const [a, b] = doc.providers.gw.models;
		expect(a.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(b.cost).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("normalizes cost tiers to complete rate sets and drops tiers without a threshold", () => {
		expect(normalizeModelCost({ input: 1, tiers: [{ inputTokensAbove: 272_000, input: 2 }] })).toEqual({
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }],
		});
	});
});

describe("compiler validation diagnostics", () => {
	const route = { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } };

	it("rejects an invalid provider id instead of emitting it", () => {
		const { doc, diagnostics } = compileProfiles([
			{
				id: "bad/id",
				name: "Bad",
				baseUrl: "https://gw.example.com",
				models: [{ id: "m", name: "M", enabled: true, apiRoutes: route }],
			},
		]);
		expect(doc.providers).toEqual({});
		expect(
			diagnostics.some((d) => d.severity === "error" && d.message.includes("not a valid models.json provider id")),
		).toBe(true);
	});

	it("rejects an empty baseUrl", () => {
		const { doc, diagnostics } = compileProfiles([
			{ id: "gw", name: "G", baseUrl: "  ", models: [{ id: "m", name: "M", enabled: true, apiRoutes: route }] },
		]);
		expect(doc.providers).toEqual({});
		expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("no baseUrl"))).toBe(true);
	});

	it("rejects an empty model id", () => {
		const { doc, diagnostics } = compileProfiles([
			{
				id: "gw",
				name: "G",
				baseUrl: "https://gw.example.com",
				models: [{ id: "  ", name: "M", enabled: true, apiRoutes: route }],
			},
		]);
		expect(doc.providers.gw).toBeUndefined();
		expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("empty id"))).toBe(true);
	});

	it("rejects non-positive contextWindow or maxTokens", () => {
		const { doc, diagnostics } = compileProfiles([
			{
				id: "gw",
				name: "G",
				baseUrl: "https://gw.example.com",
				models: [{ id: "m", name: "M", enabled: true, contextWindow: 0, apiRoutes: route }],
			},
		]);
		expect(doc.providers.gw).toBeUndefined();
		expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("non-positive"))).toBe(true);
	});

	it("warns and skips duplicate model ids", () => {
		const { doc, diagnostics } = compileProfiles([
			{
				id: "gw",
				name: "G",
				baseUrl: "https://gw.example.com",
				models: [
					{ id: "m", name: "First", enabled: true, apiRoutes: route },
					{ id: "m", name: "Second", enabled: true, apiRoutes: route },
				],
			},
		]);
		expect(doc.providers.gw.models).toHaveLength(1);
		expect(doc.providers.gw.models[0].name).toBe("First");
		expect(diagnostics.some((d) => d.severity === "warning" && d.message.includes("more than once"))).toBe(true);
	});

	it("falls back to the id for empty provider and model names", () => {
		const { doc } = compileProfiles([
			{
				id: "gw",
				name: "  ",
				baseUrl: "https://gw.example.com",
				models: [{ id: "m", name: "", enabled: true, apiRoutes: route }],
			},
		]);
		expect(doc.providers.gw.name).toBe("gw");
		expect(doc.providers.gw.models[0].name).toBe("m");
	});

	it("preserves an auth association mismatch as an error diagnostic", () => {
		const { diagnostics } = compileProfiles([
			{
				id: "gw",
				name: "G",
				baseUrl: "https://gw.example.com",
				authProviderId: "other",
				models: [{ id: "m", name: "M", enabled: true, apiRoutes: route }],
			},
		]);
		expect(
			diagnostics.some((d) => d.severity === "error" && d.message.includes("does not match compiled provider id")),
		).toBe(true);
	});
});

describe("merge ownership", () => {
	function compiledWithGateway(): ReturnType<typeof compileProfiles>["doc"] {
		return compileProfiles([
			{
				id: "gw",
				name: "Gateway",
				baseUrl: "https://gw.example.com",
				models: [
					{
						id: "m",
						name: "M",
						enabled: true,
						apiRoutes: { "openai-completions": { sdkBaseUrl: "https://gw.example.com" } },
					},
				],
			},
		]).doc;
	}

	it("preserves a user provider that carries a type field and removes only stale managed ids", () => {
		const existing = {
			providers: {
				user: { type: "api", baseUrl: "https://user.example.com", models: [] },
				stale: { name: "stale profile provider" },
				keep: { name: "keep" },
			},
		};
		const merged = mergeIntoModelsJson(existing, compiledWithGateway(), ["stale"]);
		expect(Object.keys(merged.providers).sort()).toEqual(["gw", "keep", "user"]);
	});

	it("never deletes providers when no stale ids are supplied", () => {
		const existing = { providers: { oldProfile: { name: "old" } } };
		const merged = mergeIntoModelsJson(existing, { providers: {} }, []);
		expect(merged.providers.oldProfile).toBeDefined();
	});
});

describe("manager JSONC handling, manifest, and draft consistency", () => {
	it("compiles into a JSONC models.json without losing user providers", () => {
		const agentDir = join(dir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));
		atomicWriteFileSync(
			modelsPath,
			`// user models\n{\n\t"providers": {\n\t\t"user": { "baseUrl": "https://user.example.com", "api": "openai-completions", "models": [{ "id": "u" }] } // keep me\n\t}\n}\n`,
		);
		const draft = createProfileDraft("Gateway", "https://gw.example.com", "gateway");
		draft.models = [
			makeModel({
				id: "vendor/model-x",
				availableApis: ["openai-completions"],
				apiPreference: "openai-completions",
			}),
		];
		const { diagnostics } = saveProfile(store, draft, modelsPath);
		expect(diagnostics).toEqual([]);
		const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(modelsJson.providers.user).toBeDefined();
		expect(modelsJson.providers.gateway).toBeDefined();
	});

	it("leaves an unparseable models.json unchanged and reports an error", () => {
		const agentDir = join(dir, "agent");
		const modelsPath = join(agentDir, "models.json");
		const store = new ProfilesStore(join(agentDir, "profile-state.json"));
		const broken = "{ this is not json";
		atomicWriteFileSync(modelsPath, broken);
		const draft = createProfileDraft("G", "https://gw.example.com", "g");
		draft.models = [makeModel({ id: "m", availableApis: ["openai-completions"] })];
		const { diagnostics } = saveProfile(store, draft, modelsPath);
		expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("could not be parsed"))).toBe(true);
		expect(readFileSync(modelsPath, "utf-8")).toBe(broken);
	});

	it("createProfileDraft uses the auth provider id as the stable id and rejects invalid ids", () => {
		const draft = createProfileDraft("Gateway", "https://gw.example.com", "my-gateway");
		expect(draft.id).toBe("my-gateway");
		expect(draft.authReference.authProviderId).toBe("my-gateway");
		expect(() => createProfileDraft("G", "https://gw.example.com", "bad/id")).toThrow(/Invalid auth provider id/);
		expect(isValidProviderId("")).toBe(false);
		expect(isValidProviderId("a b")).toBe(false);
		expect(isValidProviderId("a/b")).toBe(false);
		expect(isValidProviderId("ok-id.1")).toBe(true);
	});

	it("does not rewrite a mismatched auth association when converting profile input", () => {
		const profile = makeProfile({ id: "gw", authReference: { authProviderId: "other" } });
		expect(toCompilerProfileInput(profile).authProviderId).toBe("other");
	});
});

describe("gateway discovery", () => {
	it("keeps catalog-declared APIs when an empty inference probe returns 403", async () => {
		const profile = makeProfile({ id: "gateway", authReference: { authProviderId: "gateway" } });
		const result = await discoverProfile(profile, {
			fetch: async (_input, init) => {
				void _input;
				if ((init?.method ?? "GET") === "GET") {
					return new Response(JSON.stringify({ data: [{ id: "model", supported_endpoint_types: ["openai"] }] }), {
						status: 200,
					});
				}
				return new Response(JSON.stringify({ error: { message: "empty request rejected" } }), { status: 403 });
			},
		});
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].availableApis).toEqual(["openai-completions"]);
		expect(result.candidates[0].warnings).toContainEqual(expect.stringContaining("inference probe was rejected"));
	});
});
