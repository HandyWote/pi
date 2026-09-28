# Pi Extensions

This repository is an independent collection of extensions for [Pi](https://github.com/earendil-works/pi). It does not contain Pi's runtime or a fork of Pi's source code. Each package is developed, versioned, tested, and published on its own.

The extensions call Pi through its public extension API. They are installed into an existing Pi installation and loaded at runtime. The relationship is therefore a consumer relationship: Pi provides the host session, tools, UI, model registry, and event bus; these packages add optional behavior on top.

| Extension | Purpose |
| --- | --- |
| [pi-permissions](extensions/pi-permissions) | Permission modes, rules, Bash analysis, and approval handling |
| [pi-profile](extensions/pi-profile) | Gateway profiles, API routing, model discovery, and model pools |
| [pi-subagent](extensions/pi-subagent) | Persistent foreground and background subagents |
| [pi-todo](extensions/pi-todo) | Persistent task lists and orchestration |

## Install

Install the extensions you need from Pi:

```bash
pi install npm:@handy_wote/pi-permissions
pi install npm:@handy_wote/pi-profile
pi install npm:@handy_wote/pi-subagent
pi install npm:@handy_wote/pi-todo
```

Each extension has its own README with configuration, commands, tools, and integration details.

## Relationship with Pi

The packages depend on published Pi interfaces such as `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` for type definitions and runtime calls. These dependencies are external package dependencies; their source is not part of this repository.

Extensions remain usable independently unless an extension explicitly documents an optional protocol. For example, `pi-todo` and `pi-subagent` communicate through namespaced event messages and opaque metadata when both are installed. Neither extension imports the other's source code.

## Development

Requires Node.js 22.19 or later.

```bash
npm ci --ignore-scripts
npm run check
./test.sh
npm run build
```

Build or check one extension with:

```bash
npm run build --workspace @handy_wote/pi-todo
npm run check --workspace @handy_wote/pi-todo
```

Tests use local fixtures and the faux provider. They do not require provider credentials or network access. Shared integration-test support lives in [test/harness.ts](test/harness.ts).

## Releases

Extensions have independent versions and changelogs. See [Extension Releases](docs/extension-releases.md) for version preparation and npm publishing through GitHub Actions.

Dependencies are pinned to exact versions. Install with lifecycle scripts disabled and review lockfile changes. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository rules.

## License

MIT. See [LICENSE](LICENSE).
