import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@handy_wote/pi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();
const isolatedProfilesDir = mkdtempSync(join(tmpdir(), "pi-model-runtime-test-"));
let isolatedProfilesIndex = 0;

process.once("exit", () => {
	rmSync(isolatedProfilesDir, { recursive: true, force: true });
});

function nextIsolatedProfilesPath(): string {
	return join(isolatedProfilesDir, `profiles-${isolatedProfilesIndex++}.json`);
}

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

export async function createModelRegistry(
	credentials: CredentialStore,
	modelsPath?: string,
	profilesPath?: string,
): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath,
			profilesPath: profilesPath ?? nextIsolatedProfilesPath(),
			allowModelNetwork: false,
		}),
	);
}

export async function createInMemoryModelRegistry(
	credentials: CredentialStore,
	profilesPath: string,
): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, profilesPath, allowModelNetwork: false }));
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
