import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

interface PackageManagerInternals {
	runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
	runCommandCapture: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
	shouldUpdateNpmSource: (source: unknown, scope: string) => Promise<boolean>;
	npmHasAvailableUpdate: (source: unknown, installedPath: string) => Promise<boolean>;
}

describe("issue #8226 npm update semver comparison", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-8226-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function installNpmPackage(name: string, version: string): string {
		const installedPath = join(cwd, ".pi", "npm", "node_modules", name);
		mkdirSync(installedPath, { recursive: true });
		writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name, version }));
		return installedPath;
	}

	it("skips npm updates when the installed version is newer than the registry version", async () => {
		installNpmPackage("example", "2.0.0");
		settingsManager.setProjectPackages(["npm:example"]);

		const internals = packageManager as unknown as PackageManagerInternals;
		internals.runCommandCapture = vi.fn().mockResolvedValue('"1.9.0"');
		const runCommandSpy = vi.fn<PackageManagerInternals["runCommand"]>();
		internals.runCommand = runCommandSpy;

		await packageManager.update("npm:example");

		expect(internals.runCommandCapture).toHaveBeenCalledWith(
			"npm",
			["view", "example", "version", "--json"],
			expect.objectContaining({ cwd, timeoutMs: expect.any(Number) }),
		);
		expect(runCommandSpy).not.toHaveBeenCalled();
	});

	it("does not report npm updates when the installed version is newer than the registry version", async () => {
		installNpmPackage("example", "2.0.0");
		settingsManager.setProjectPackages(["npm:example"]);

		const internals = packageManager as unknown as PackageManagerInternals;
		internals.runCommandCapture = vi.fn().mockResolvedValue('"1.9.0"');

		const updates = await packageManager.checkForAvailableUpdates();
		expect(updates).toEqual([]);
	});
});
