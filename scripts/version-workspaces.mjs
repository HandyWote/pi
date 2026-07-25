#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const commandArgs = process.argv.slice(2);
const dryRunIndex = commandArgs.indexOf("--dry-run");
const dryRun = dryRunIndex !== -1;
if (dryRun) commandArgs.splice(dryRunIndex, 1);
const target = commandArgs[0];
if (!target || !/^(major|minor|patch|\d+\.\d+\.\d+)$/.test(target)) {
	console.error("Usage: node scripts/version-workspaces.mjs <major|minor|patch|x.y.z> [--dry-run]");
	process.exit(1);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const query = spawnSync(npm, ["query", ".workspace"], { encoding: "utf8" });
if (query.status !== 0) {
	process.stderr.write(query.stderr);
	process.exit(query.status ?? 1);
}
const workspaces = JSON.parse(query.stdout)
	.filter((workspace) => !workspace.location.startsWith("packages/extensions/"))
	.map((workspace) => workspace.name);
if (dryRun) {
	console.log(`Would set ${target} for:\n${workspaces.map((workspace) => `  ${workspace}`).join("\n")}`);
	process.exit(0);
}
const args = ["version", target, "--no-git-tag-version", "--ignore-scripts"];
for (const workspace of workspaces) {
	args.push("--workspace", workspace);
}

const result = spawnSync(npm, args, { stdio: "inherit" });
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}
