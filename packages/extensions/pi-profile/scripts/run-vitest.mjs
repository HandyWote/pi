import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const candidates = [
	join(packageDir, "..", "..", "..", "node_modules", "vitest", "dist", "cli.js"),
	join(packageDir, "..", "..", "coding-agent", "node_modules", "vitest", "dist", "cli.js"),
];
const runner = candidates.find(existsSync);
if (!runner) {
	console.error("Cannot find the monorepo Vitest runner. Run npm ci --ignore-scripts from the repository root.");
	process.exit(1);
}
const result = spawnSync(process.execPath, [runner, "--run", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
