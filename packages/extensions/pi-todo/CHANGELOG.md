# Changelog

## [Unreleased]

### Breaking Changes

- Replaced wave and review tools with dynamic create, list, get, update, claim, release, and delete operations.
- Reduced public task status to `pending`, `in_progress`, and `completed`.

### Added

- Added atomic file persistence, recoverable cross-process claims, session resume, fork and tree isolation, and compaction continuation context.
- Added optional versioned Agent lifecycle metadata integration without a package dependency.

### Changed

- Rebuilt the widget around separate active, ready, and dependency-blocked sections with narrow-terminal truncation.
- Made review an optional ordinary task and removed task retry policies.

## [0.1.1] - 2026-07-28

### Added

- Added automatic todo orchestration when users confirm execution of an existing plan.

### Changed

- Moved the pi-todo progress widget above pending messages and status rows.

## [0.1.0] - 2026-07-25

### Added

- Added dependency-aware todo waves, optional subagent lifecycle tracking, review outcomes, failure propagation, and an above-editor progress widget.
