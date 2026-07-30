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

Claims use an owner, opaque token, task revision, and a cross-process file lock. Entering `in_progress` is only possible through `todo_claim`. Updating or releasing claimed work requires the current claim token.

## Persistence

Lists are stored under `~/.pi/agent/todo/lists` by default. Set `PI_AGENT_DIR` to relocate all Pi agent data. Writes use temporary files, atomic rename, file and directory sync, backups, and recoverable process-owned locks.

The active list and revision are recorded in session custom entries. Reload and resume restore the list. Forks and historical session-tree navigation clone the visible revision, so branches do not mutate one another. Live claims are not inherited by a fork. After compaction, a compact active digest is inserted into model context independently of the widget.

## Optional Agent Protocol

There is no package dependency or source import between Todo and any Agent extension. Optional integration uses EventBus channel `pi:agent:lifecycle` with protocol version `1`. Todo reads only these namespaced entries from opaque lifecycle metadata:

```text
pi.todo/list-id
pi.todo/task-id
pi.todo/claim-token
```

An Agent child may receive the same metadata through the generic `PI_AGENT_CONTEXT` JSON value. Todo parses its namespace itself.

`queued`, `started`, or `running` events transfer a matching claim to the stable agent ID. `failed`, `stopped`, or `interrupted` events release only that matching owner and token. Agent success never completes a Todo; the worker explicitly completes it after meeting its acceptance criteria. Durable correctness does not depend on EventBus delivery.
