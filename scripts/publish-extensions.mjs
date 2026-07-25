#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extensionTag, loadExtensionPackages, selectExtensionPackages } from "./extension-packages.mjs";

function commandForPlatform(command) {
	return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}
	return result;
}

function tryRun(command, args) {
	return spawnSync(commandForPlatform(command), args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
}

function parseArguments() {
	const options = { base: undefined, dryRun: false, extensions: undefined, head: "HEAD" };
	const args = process.argv.slice(2);
	while (args.length > 0) {
		const arg = args.shift();
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--base" || arg === "--extensions" || arg === "--head") {
			const value = args.shift();
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--base") options.base = value;
			if (arg === "--extensions") options.extensions = value;
			if (arg === "--head") options.head = value;
			continue;
		}
		throw new Error(`Unknown argument ${arg}`);
	}
	if ((options.base === undefined) === (options.extensions === undefined)) {
		throw new Error("Specify exactly one of --base <git-ref> or --extensions <comma-separated-slugs>");
	}
	return options;
}

function changedPackages(base, head) {
	const diff = run("git", ["diff", "--name-only", base, head, "--", "packages/extensions"], { capture: true });
	const changedManifests = new Set(
		diff.stdout
			.split("\n")
			.filter((path) => /^packages\/extensions\/[^/]+\/package\.json$/.test(path)),
	);

	return loadExtensionPackages().filter((pkg) => {
		const manifestPath = pkg.manifestPath.replaceAll("\\", "/");
		if (!changedManifests.has(manifestPath)) return false;
		const previous = tryRun("git", ["show", `${base}:${manifestPath}`]);
		if (previous.status !== 0) return true;
		const previousManifest = JSON.parse(previous.stdout);
		return previousManifest.version !== pkg.manifest.version;
	});
}

function isPublished(name, version) {
	const result = tryRun("npm", ["view", `${name}@${version}`, "version", "--json"]);
	if (result.status === 0 && result.stdout.trim()) return true;
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return false;
	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function validatePack(pkg) {
	for (const output of [pkg.manifest.main, pkg.manifest.types]) {
		if (typeof output !== "string" || !existsSync(join(pkg.directory, output))) {
			throw new Error(`${pkg.manifest.name} is missing build output ${output ?? "<undefined>"}`);
		}
	}
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: pkg.directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed`);
}

function resolveReleaseCommit(packages, head) {
	const resolvedHead = run("git", ["rev-parse", head], { capture: true }).stdout.trim();
	for (const pkg of packages) {
		const manifestPath = pkg.manifestPath.replaceAll("\\", "/");
		const committed = run("git", ["show", `${resolvedHead}:${manifestPath}`], { capture: true });
		const manifest = JSON.parse(committed.stdout);
		if (manifest.name !== pkg.manifest.name || manifest.version !== pkg.manifest.version) {
			throw new Error(`${pkg.manifest.name}@${pkg.manifest.version} is not present at release commit ${resolvedHead}`);
		}
	}
	return resolvedHead;
}

function ensureTags(packages, releaseCommit, dryRun) {
	const newTags = [];
	for (const pkg of packages) {
		const tag = extensionTag(pkg);
		const existing = tryRun("git", ["rev-parse", "--verify", `refs/tags/${tag}`]);
		if (existing.status === 0) {
			if (existing.stdout.trim() !== releaseCommit) {
				throw new Error(`Tag ${tag} already points to ${existing.stdout.trim()}, expected ${releaseCommit}`);
			}
			console.log(`Tag ${tag} already points to the release commit.`);
			continue;
		}
		if (dryRun) {
			console.log(`Would create tag ${tag} at ${releaseCommit}.`);
			continue;
		}
		run("git", ["tag", tag, releaseCommit]);
		newTags.push(tag);
	}
	if (newTags.length > 0) {
		run("git", ["push", "origin", ...newTags.map((tag) => `refs/tags/${tag}`)]);
	}
}

const options = parseArguments();
const selectors = options.extensions?.split(",").map((value) => value.trim()).filter(Boolean);
if (options.extensions !== undefined && selectors?.length === 0) {
	throw new Error("--extensions must contain at least one extension slug");
}
const packages = options.extensions
	? selectExtensionPackages(selectors)
	: changedPackages(options.base, options.head);

if (packages.length === 0) {
	console.log("No extension version changes found.");
	process.exit(0);
}

const releaseCommit = resolveReleaseCommit(packages, options.head);
const states = [];
for (const pkg of packages) {
	console.log(`\nPreflighting ${pkg.manifest.name}@${pkg.manifest.version}...`);
	run("npm", ["run", "build", "--workspace", pkg.manifest.name]);
	run("npm", ["run", "check", "--workspace", pkg.manifest.name]);
	run("npm", ["run", "test", "--workspace", pkg.manifest.name]);
	validatePack(pkg);
	const published = isPublished(pkg.manifest.name, pkg.manifest.version);
	console.log(published ? "  Version already exists on npm." : "  Version is available on npm.");
	states.push({ ...pkg, published });
}

ensureTags(packages, releaseCommit, options.dryRun);

if (options.dryRun) {
	console.log("\nDry run complete; no tags were pushed and no packages were published.");
	process.exit(0);
}

for (const pkg of states) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.manifest.name}@${pkg.manifest.version}: already published.`);
		continue;
	}
	run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: pkg.directory });
}
