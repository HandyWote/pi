#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseStableVersion, selectExtensionPackages } from "./extension-packages.mjs";

const args = process.argv.slice(2);
const dryRunIndex = args.indexOf("--dry-run");
const dryRun = dryRunIndex !== -1;
if (dryRun) {
	args.splice(dryRunIndex, 1);
}

const bump = args.shift();
if (!bump || !new Set(["major", "minor", "patch"]).has(bump)) {
	console.error("Usage: node scripts/version-extensions.mjs <major|minor|patch> [extension ...] [--dry-run]");
	process.exit(1);
}

function bumpVersion(version) {
	const [major, minor, patch] = parseStableVersion(version, "Extension version");
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function finalizeChangelog(path, version) {
	const content = readFileSync(path, "utf8");
	if (!content.includes("## [Unreleased]")) {
		throw new Error(`${path} does not contain an [Unreleased] section`);
	}
	if (content.includes(`## [${version}]`)) {
		throw new Error(`${path} already contains version ${version}`);
	}
	const date = new Date().toISOString().slice(0, 10);
	return content.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${date}`);
}

const packages = selectExtensionPackages(args);
if (packages.length === 0) {
	throw new Error("No publishable extensions found");
}

for (const pkg of packages) {
	const version = bumpVersion(pkg.manifest.version);
	console.log(`${pkg.manifest.name}: ${pkg.manifest.version} -> ${version}${dryRun ? " (dry run)" : ""}`);
	if (dryRun) continue;

	pkg.manifest.version = version;
	writeFileSync(pkg.manifestPath, `${JSON.stringify(pkg.manifest, null, "\t")}\n`);
	const changelogPath = `${pkg.directory}/CHANGELOG.md`;
	writeFileSync(changelogPath, finalizeChangelog(changelogPath, version));
}

if (!dryRun) {
	const result = spawnSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["install", "--package-lock-only", "--ignore-scripts"],
		{ stdio: "inherit" },
	);
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
