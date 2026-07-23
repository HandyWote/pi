import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("SettingsManager compat registry provenance", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-settings-registries-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves global descriptors relative to the global settings directory", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compatRegistries: [{ type: "file", path: "registries/global.json" }] }),
		);
		expect(SettingsManager.create(cwd, agentDir).getCompatRegistries()).toEqual([
			{ type: "file", path: "registries/global.json", baseDir: agentDir },
		]);
	});

	it("uses project provenance when project settings replace the global array", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compatRegistries: [{ type: "file", path: "global.json" }] }),
		);
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ compatRegistries: [{ type: "file", path: "project.json" }] }),
		);
		expect(SettingsManager.create(cwd, agentDir).getCompatRegistries()).toEqual([
			{ type: "file", path: "project.json", baseDir: join(cwd, ".pi") },
		]);
	});
});
