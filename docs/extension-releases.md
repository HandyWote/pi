# Extension Releases

Packages under `packages/extensions/*` are optional pi packages. They remain npm workspaces for local development and CI compatibility checks, but they do not participate in the core package lockstep version or the core `vX.Y.Z` release.

## Package Contract

Every publishable extension must:

- use a directory slug matching the final segment of its npm package name;
- use a stable `x.y.z` version independent of the core packages;
- declare at least one `pi.extensions` entry;
- provide `build`, `check`, and `test` scripts;
- include its build output and documentation in the packed package.

## Prepare Versions

Bump every publishable extension independently from its current version:

```bash
npm run version:extensions -- patch
```

Bump only selected extensions in one operation:

```bash
npm run version:extensions -- minor pi-todo pi-foo
```

The command updates each selected manifest and CHANGELOG, then refreshes `package-lock.json`. Commit the extension source, manifest, CHANGELOG, and lockfile together.

## Automatic Publish

On a push to `main`, `.github/workflows/publish-extensions.yml` compares changed extension manifests with the previous commit. A package is selected only when its `version` changed.

The workflow builds the core dependencies once, then builds, checks, tests, and dry-run packs every selected extension. It publishes each unpublished version with npm provenance, then creates one lightweight tag for that successfully published package:

```text
pi-todo@0.1.1
pi-foo@0.3.0
```

A rerun accepts tags already pointing at the release commit and skips versions already present on npm. A failed publish cannot leave a new release tag ahead of its npm package.

Each new npm package must be bootstrapped once and configured to trust `.github/workflows/publish-extensions.yml` in the `npm-publish` GitHub environment.
