import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findExtensionPackageDirectories } from "./package-workspaces.mjs";

const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(version, context) {
	const match = STABLE_SEMVER_RE.exec(version);
	if (!match) {
		throw new Error(`${context} must use a stable x.y.z version, received ${version}`);
	}
	return match.slice(1).map(Number);
}

export function loadExtensionPackages() {
	const packages = findExtensionPackageDirectories()
		.map((directory) => {
			const manifestPath = join(directory, "package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			return { directory, manifest, manifestPath, slug: basename(directory) };
		})
		.filter((pkg) => pkg.manifest.private !== true);

	const names = new Set();
	const slugs = new Set();
	for (const pkg of packages) {
		if (typeof pkg.manifest.name !== "string" || !pkg.manifest.name.endsWith(`/${pkg.slug}`)) {
			throw new Error(`${pkg.manifestPath} name must end with /${pkg.slug}`);
		}
		parseStableVersion(pkg.manifest.version, `${pkg.manifestPath} version`);
		if (!Array.isArray(pkg.manifest.pi?.extensions) || pkg.manifest.pi.extensions.length === 0) {
			throw new Error(`${pkg.manifestPath} must declare at least one pi.extensions entry`);
		}
		for (const script of ["build", "check", "test"]) {
			if (typeof pkg.manifest.scripts?.[script] !== "string") {
				throw new Error(`${pkg.manifestPath} must declare a ${script} script`);
			}
		}
		if (names.has(pkg.manifest.name)) {
			throw new Error(`Duplicate extension package name ${pkg.manifest.name}`);
		}
		if (slugs.has(pkg.slug)) {
			throw new Error(`Duplicate extension slug ${pkg.slug}`);
		}
		names.add(pkg.manifest.name);
		slugs.add(pkg.slug);
	}

	return packages.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function selectExtensionPackages(selectors) {
	const packages = loadExtensionPackages();
	if (selectors.length === 0) {
		return packages;
	}

	const requested = new Set(selectors);
	const selected = packages.filter((pkg) => requested.has(pkg.slug) || requested.has(pkg.manifest.name));
	for (const selector of requested) {
		if (!selected.some((pkg) => pkg.slug === selector || pkg.manifest.name === selector)) {
			throw new Error(`Unknown extension ${selector}`);
		}
	}
	return selected;
}

export function extensionTag(pkg) {
	return `${pkg.slug}@${pkg.manifest.version}`;
}
