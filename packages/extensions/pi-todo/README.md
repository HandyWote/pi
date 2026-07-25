# pi-todo

`@handy_wote/pi-todo` is an optional pi package for dependency-aware todo orchestration. The main session turns an explicit plan into a validated task graph, executes dependency-ready waves, reviews results, and records outcomes. When the `Agent` tool from `@tintinweb/pi-subagents` is active, tasks in a wave can run in parallel; otherwise the main session executes them sequentially.

## Install

From npm:

```bash
pi install npm:@handy_wote/pi-todo
```

From this repository:

```bash
pi install ./packages/extensions/pi-todo
```

## Use

Load a Markdown plan:

```text
/todo docs/plans/example.md
```

Or provide an inline plan:

```text
/todo update auth state, then update the API, then add tests
```

The extension keeps state in memory. Starting a new session, resuming another session, reloading extensions, or exiting clears the active todo graph.

## Tools

- `write_todo` validates and initializes the graph.
- `next_wave` starts dependency-ready tasks after the preceding active wave is reviewed.
- `mark` records `done`, `fix-needed`, `off-target`, or `failed` review outcomes.

Only the main session can mutate its todo state. `pi-subagents` integration uses lifecycle events and exact `pi-todo:<task-id>` agent descriptions; no runtime dependency on `pi-subagents` is required.
