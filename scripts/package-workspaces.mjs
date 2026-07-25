import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);
const EXTENSIONS_ROOT = join("packages", "extensions");

export function findPackageDirectories(root = "packages") {
	const packageDirectories = [];

	function visit(directory) {
		if (existsSync(join(directory, "package.json"))) {
			packageDirectories.push(directory);
		}

		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			visit(join(directory, entry.name));
		}
	}

	visit(root);
	return packageDirectories.sort();
}

export function findExtensionPackageDirectories() {
	return findPackageDirectories(EXTENSIONS_ROOT);
}

export function findLockstepPackageDirectories() {
	const extensionDirectories = new Set(findExtensionPackageDirectories());
	return findPackageDirectories().filter((directory) => !extensionDirectories.has(directory));
}
