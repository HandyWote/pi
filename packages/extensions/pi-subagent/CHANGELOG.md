# Changelog

## [Unreleased]

### Breaking Changes

- Removed `transcriptPath` from `AgentRecord` and `AgentTerminalEventDetails`: subagent transcripts are no longer written to disk and now live in a bounded in-memory buffer (200KB per agent, oldest lines evicted first). Legacy persisted records that still carry the field load successfully and are migrated on the next save.

### Added

- Subagent children now watch a supervisor pipe for parent death: the parent spawns each child with an extra stdio pipe and injects `PI_SUBAGENT_SUPERVISOR_FD`; when the parent crashes, the child sees EOF and shuts down gracefully (session persisted, grandchildren terminated) within milliseconds instead of burning tokens as an orphan. Fully event-driven, no polling; behavior is unchanged when the env var is absent.

- On startup, the subagent manager now sweeps foreign session state past a 7-day staleness window: stale crashed-session registries are deleted after terminating their still-verifiable orphaned children and reclaiming session directories, prompts, worktrees, and branches, and unreferenced stale entries under `sessions/`, `prompts/`, `worktrees/`, `transcripts/`, and stale `registries/*.tmp` files are removed (largest win: legacy transcript directories). Fresh state from concurrent live sessions is never touched.

### Changed

- Registries now record the owning pi process (pid plus process start token) and the startup sweep uses it as a fact check: a foreign session whose recorded parent process is still alive is never swept, no matter how long it has been idle. Registries written by older versions (without the recorded identity) keep the previous mtime-only judgment.

- Dirty worktrees are never force-removed anymore: at agent teardown and in the startup sweep, a worktree with uncommitted changes is retained with a stderr notice pointing at its path instead of being destroyed. Clean worktrees are removed as before; the branch of a retained worktree stays alive because the worktree still holds it checked out. Worktree contents belong to the user and git, so the decision to keep or discard them is never made by the agent.

## [0.4.3] - 2026-08-28

### Added

- The persistent agent panel now shows live status rows: each row displays the subagent's latest assistant text (falling back to the most recent activity, then the launch task) and terminal agents drop out of the panel immediately while their records stay in the registry for the whole session.
- The `/agents` detail view is now a live, scrollable transcript: assistant text renders through the main-session Markdown theme, tool calls render as compact rows, and running agents auto-follow the tail with line/page scrolling, `G`/`g` jump, and `Esc` back. Transcripts are parsed incrementally from the child transcript file and polled off the render path ([#8](https://github.com/HandyWote/pi/pull/8)).

## [0.4.2] - 2026-08-20

### Added

- Coordinator guidance to treat `REJECTED`-prefixed todo results as rejected operations and to call `todo_list` and confirm every task is completed before reporting a final conclusion ([#7](https://github.com/HandyWote/pi/pull/7)).

### Changed

- Terminal completion notifications no longer direct `agent_resume`; they show a neutral "Result available via agent_list" hint and summarize the task to its first line ([#7](https://github.com/HandyWote/pi/pull/7)).
- `agent_output` now returns a snapshot by default instead of blocking until completion, and warns against polling for terminal events.
- `agent_resume` on an already-completed agent states that it starts a new run with new instructions.

## [0.4.1] - 2026-08-18

### Fixed

- Fixed the `/swarm` worker pool being deleted on session shutdown: the pool snapshot is shared configuration and now survives exit, and sessions that start with an existing pool receive the coordinator guidance at session start ([#5](https://github.com/HandyWote/pi/pull/5)).

## [0.4.0] - 2026-08-18

### Added

- Added an interactive agent management view for `/agents` in TUI mode: active-first list with search, live status detail (task, usage, duration, recent activities), stop (`x`) and resume (`r`, with prompt input via `app.agent.resume`). Non-TUI modes keep the select-menu flow.

### Changed

- `/swarm` now saves the worker pool through the trailing `[ Save pool ]` list row instead of Ctrl+S, which browser-based terminals (e.g. VSCode web) swallow. Escape cancels without writing.
- Subagent state is now scoped to the parent session: on `session_shutdown` children are terminated and the session's records, transcripts, child sessions, prompts, and worktree branches are deleted; a leftover registry from a crash is terminated and cleared on the next start instead of being resumed as `interrupted` records. `agent_resume` remains available within the session.

### Fixed

- Fixed `/swarm` coordinator guidance being injected as a user message, which triggered an immediate model turn and could be misread as a plan execution request; the rules now ride along with the next real prompt as a hidden custom-role message.

## [0.3.0] - 2026-08-14

### Added

- Added TUI notification cards (`registerMessageRenderer`) and a persistent agent panel above the editor (`setWidget`) showing live status, tool counts, tokens, and duration.

### Changed

- Terminal notifications now use the core `event` lane: completion events are delivered at the next tool-round boundary (seconds) instead of after the current run settles (potentially hours). Notification payloads are structured (`AgentTerminalEventDetails` in `details`: status, task, result, usage, transcript path) with a three-line summary in `content`.
- Batched terminal notifications: background agent completions within a short window are merged into a single follow-up message instead of interrupting the parent once per agent.

### Fixed

- Fixed multi-line agent tasks breaking the agent panel's single-line row contract: newlines are now flattened in panel rows and notification cards, so rows stay single-line during incremental redraws.

## [0.2.0] - 2026-08-04

### Breaking Changes

- Upgraded lifecycle events and persisted agent records to version 2 with per-invocation run IDs; version 1 registry records are discarded rather than migrated.

### Added

- Added `/swarm`: interactive worker model pool configuration (candidates from the session model scope, ordered by priority, snapshot-persisted to `worker-models.json`) and coordinator behavior guidance. Worker model assignment: agent definition `model` > pool order > main-session model.
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
