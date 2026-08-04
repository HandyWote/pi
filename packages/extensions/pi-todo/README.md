# pi-todo

`@handy_wote/pi-todo` is a persistent, dependency-aware task orchestrator for Pi. It works without an Agent plugin: the main session can create, claim, execute, and complete ready tasks itself. When an independent Agent tool is installed, the model can delegate several claimed tasks in parallel through opaque metadata.

## Install

```bash
pi install npm:@handy_wote/pi-todo
```

From this repository:

```bash
pi install ./packages/extensions/pi-todo
```

## Use

Import a Markdown or inline plan:

```text
/todo docs/plans/example.md
/todo update auth state, then update the API, then add tests
```

Manage the active list:

```text
/todo
/todo list
/todo inspect T1
/todo delete T1
/todo clear
```

`delete` and `clear` require confirmation. The model may also create a todo automatically after the user confirms execution of a multi-step plan. Active state is injected again when the user says `继续` or `continue`.

## Task Model

Public task status is limited to:

- `pending`
- `in_progress`
- `completed`

A pending task is ready when every dependency is completed. Independent tasks have no wave barrier and can be claimed concurrently. Review is optional and, when useful, is represented as an ordinary task. The extension has no task retry counters or automatic reruns.

## Tools

- `write_todo`: replace the active list from a confirmed plan.
- `todo_create`: dynamically add tasks.
- `todo_list`: list all or ready tasks.
- `todo_get`: inspect one task.
- `todo_update`: edit task content, dependencies, or complete claimed work.
- `todo_claim`: atomically claim ready work.
- `todo_release`: return unfinished owned work to pending.
- `todo_delete`: delete a task and clean dependent edges.

Claims use an owner, task revision, and a cross-process file lock. The owner is coordination and display data, not an authorization credential. Entering `in_progress` is only possible through `todo_claim`; an in-progress task can then be edited, completed, returned to pending, released, or deleted without a token. `todo_claim` returns namespaced metadata and a ready-to-use `worker` batch item for delegation.

## Persistence

Lists are stored under `~/.pi/agent/todo/lists` by default. Set `PI_AGENT_DIR` to relocate all Pi agent data. Writes use temporary files, atomic rename, file and directory sync, and backups. Cross-process exclusion uses complete, uniquely owned Lamport bakery contenders with a 60-second default wait budget. Linux process start ticks, macOS process start time, and Windows process creation time detect dead processes and PID reuse. Locks from a previous boot on the same host are stale. When owner identity cannot be verified, or the lock belongs to another host, Pi retains it conservatively and reports the reason on timeout. The main document keeps 20 recent revisions and up to 1000 per-revision snapshots; branch points older than that retention window expire.

The active list and revision are recorded in session custom entries. Reload and resume restore the list. Forks and historical session-tree navigation clone the visible revision, so branches do not mutate one another. Live claims are not inherited by a fork. After compaction, a compact active digest is inserted into model context independently of the widget. Each digest identifies its list and revision so a later `todo_list` call can supersede a queued historical snapshot.

## Optional Agent Protocol

There is no package dependency or source import between Todo and any Agent extension. Optional integration uses EventBus channel `pi:agent:lifecycle` with protocol version `2`. Todo reads only these namespaced entries from opaque lifecycle metadata:

```text
pi.todo/list-id
pi.todo/task-id
```

An Agent child may receive the same metadata through the generic `PI_AGENT_CONTEXT` JSON value. Todo parses its namespace itself.

Each lifecycle event includes a stable agent ID and a run ID that changes on every start or resume. `queued`, `started`, or `running` events assign the task to that agent. `failed`, `stopped`, or `interrupted` events release it only while that agent still owns it. Events for a task are serialized, and terminal or stale events from an older run cannot affect the current run. A `completed` event synchronizes the revision after the worker explicitly updates the task; Agent success never completes a Todo by itself.

Before the first agent turn or `/todo` command after reload or resume, Todo emits protocol version `2` on `pi:agent:status-request`. This happens after every extension has handled `session_start`, so plugin loading order does not affect recovery. A compatible Agent plugin may answer by re-emitting `pi:agent:lifecycle` with `running`, its current run ID, and the original metadata. Current-session ownership is preserved directly, while unconfirmed external owners are atomically released to `pending`. Version 1 lifecycle events are ignored.

When two or more ready tasks are independent and have separate file ownership, the model is instructed to claim them and use one background `worker` batch. Small, coupled, and same-file tasks remain in the main session. The read-only `explore` agent is reserved for unbound investigation because it cannot update Todo state.
