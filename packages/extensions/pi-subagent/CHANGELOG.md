# Changelog

## [Unreleased]

### Breaking Changes

- Upgraded lifecycle events and persisted agent records to version 2 with per-invocation run IDs; version 1 registry records are discarded rather than migrated.

### Added

- Added built-in `worker` and read-only `explore` agents with user and project override support.

### Changed

- Added concrete guidance to batch independent delegated work in background mode.

### Fixed

- Terminated child processes after `agent_settled` so leaked extension handles cannot leave completed agents running indefinitely.

## [0.1.1] - 2026-07-31

### Added

- Added independent persistent foreground and background subagent orchestration.
- Added user and project agent discovery with project trust confirmation.
- Added durable lifecycle, output, stop, resume, notification, and `/agents` interfaces.
- Added stable worktree branches and crash-safe process recovery.

### Changed

- Marked terminal follow-ups as bounded historical snapshots and direct the parent to query current Agent and Todo state before acting.
