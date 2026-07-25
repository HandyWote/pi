#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { loadExtensionPackages } from "./extension-packages.mjs";

const script = process.argv[2];
if (!script) {
	console.error("Usage: node scripts/run-extension-script.mjs <script>");
	process.exit(1);
}

for (const pkg of loadExtensionPackages()) {
	const result = spawnSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["run", script, "--workspace", pkg.manifest.name],
		{ stdio: "inherit" },
	);
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
