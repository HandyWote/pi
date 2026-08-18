# Changelog

## [Unreleased]

### Added

- Auto-cleared the todo list (deleting its directory, unbinding, and clearing the widget) once every task is completed, while the completing update still returns the final document.

## [0.3.1] - 2026-08-11

### Fixed

- Fixed queued Todo reminders to replace older revisions and disappear when their list is completed, cleared, or superseded.

## [0.3.0] - 2026-08-04

### Breaking Changes

- Removed claim tokens from Todo tasks, tools, metadata, and lifecycle integration, and upgraded the optional Agent protocol to version 2.

### Changed

- Allowed in-progress tasks to be edited, released, returned to pending, or deleted without credentials.
- Added concrete background batch delegation guidance for multiple independent ready tasks.

## [0.2.1] - 2026-07-31

### Fixed

- Skip directory `fsync` after atomic writes on Windows, where directory handle sync raises `EPERM`.

## [0.2.0] - 2026-07-31

### Breaking Changes

- Replaced wave and review tools with dynamic create, list, get, update, claim, release, and delete operations.
- Reduced public task status to `pending`, `in_progress`, and `completed`.

### Added

- Added atomic file persistence, recoverable cross-process claims, session resume, fork and tree isolation, and compaction continuation context.
- Added optional versioned Agent lifecycle metadata integration without a package dependency.

### Changed

- Rebuilt the widget around separate active, ready, and dependency-blocked sections with narrow-terminal truncation.
- Made review an optional ordinary task and removed task retry policies.
- Added list and revision identifiers to active digests so queued historical snapshots are distinguishable from current Todo state.

## [0.1.1] - 2026-07-28

### Added

- Added automatic todo orchestration when users confirm execution of an existing plan.

### Changed

- Moved the pi-todo progress widget above pending messages and status rows.

## [0.1.0] - 2026-07-25

### Added

- Added dependency-aware todo waves, optional subagent lifecycle tracking, review outcomes, failure propagation, and an above-editor progress widget.
