# pi-subagent

Persistent foreground and background subagents for pi.

This package is independent from task-list extensions. It does not import Todo code or interpret Todo fields. Integrations can pass opaque string metadata and observe the versioned lifecycle event protocol.

## Install

```bash
pi install npm:@handy_wote/pi-subagent
```

The extension registers `agent_start`, `agent_list`, `agent_output`, `agent_stop`, and `agent_resume`, plus the `/agents` command and `--subagent-concurrency` flag. In TUI mode `/agents` opens an interactive management view (list, live status detail, stop with `x`, resume with `r`); non-TUI modes keep the select-menu flow. Concurrency defaults to 4 and is capped at 8. Failed agents are never retried automatically.

## Agent Definitions

The built-in `worker` and `explore` agents are available without configuration. `worker` handles implementation and investigation with the parent's available tools except subagent orchestration tools. `explore` is limited to available read-only tools and is not used for claimed Todo work. User agents live in `~/.pi/agent/agents/*.md`. Project agents live in the nearest `.pi/agents/*.md` directory.

```markdown
---
name: reviewer
description: Review a focused change
tools: read, grep
isolation: worktree
displayName: Reviewer
color: blue
---
Review the delegated change and report concrete findings.
```

`name` and `description` are required. `tools`, `model`, `isolation`, `displayName`, and `color` are optional. Isolation is `none` by default or `worktree`.

Definitions are resolved with `built-in < user < project` precedence. Project definitions require a trusted project; trusted projects skip the per-call confirmation prompt. Discovery reads only frontmatter; the prompt body is read after the trust check and its metadata is revalidated before launch. Built-in agents never require project approval.

## Operation

Foreground starts block until all requested agents finish. Background starts return stable IDs immediately and post one completion notification per agent, batched into a single follow-up when several agents finish within a short window. Completion follow-ups are bounded historical snapshots; the parent is instructed to query `agent_list`, optional `todo_list`, and `agent_output` before acting on one. A batch may contain up to eight items and runs under the same concurrency limit. Tool guidance directs the model to use one background batch when two or more independent tasks have clear ownership boundaries.

`agent_output` can poll or block with a timeout. `agent_stop` preserves partial output. `agent_resume` reuses the stable agent ID and child session; it fails instead of silently starting fresh when the durable child session is missing or invalid. Resuming a project agent repeats the current trust check. Resume is session-scoped: follow-up work belongs to the current session, and the underlying state is removed when the session ends.

## State Lifecycle

State lives under the pi agent directory in `subagents/` (registry, JSONL transcripts, child sessions, prompts, and temporary worktrees) and is scoped to the parent session: it is created on session start and deleted on `session_shutdown` (children are terminated, then the session's records, transcripts, child sessions, prompts, and worktree branches are removed). Finished agents leave no history behind — the completion summary is already part of the main conversation.

If the parent crashes, the next `initialize()` finds the leftover registry, terminates any orphan children (queued children are located by their random `--session-id <agentId>` argument; running children by PID plus process start token, with `/proc` and a `ps` fallback on Unix and PowerShell on Windows), and then clears the leftover state instead of resuming it. Recovery stops with an explicit error when a live process cannot be identified safely.

## Worker Pool

`/swarm` configures the worker model pool (an ordered snapshot persisted to `worker-models.json`). Toggle models with space, reorder with Alt+Up/Alt+Down (order is priority), then activate the trailing `[ Save pool ]` row to save and close; Escape cancels. Saving an empty selection clears the pool, after which subagents use the main-session model. Worker model assignment: agent definition `model` > pool order > main-session model. The pool is shared configuration, not session state: it survives session shutdown and is picked up by future sessions. Each session that has a pool receives the coordinator behavior guidance exactly once — at session start when the pool already exists, otherwise at first save.

Worktree isolation uses the branch `pi-subagent/<agentId>`, which is removed together with the rest of the session state on shutdown.

## Lifecycle Protocol

Lifecycle events are emitted on `pi:agent:lifecycle`:

```ts
interface AgentLifecycleEvent {
	version: 2;
	eventId: string;
	runId: string;
	agentId: string;
	parentSessionId: string;
	status: "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";
	timestamp: string;
	metadata: Record<string, string>;
}
```

The stable agent ID identifies the durable child session within the current session. A new run ID is generated for every start or resume and shared by that invocation's queued, running, and terminal events. Consumers may emit `{ version: 2, parentSessionId }` on `pi:agent:status-request` to request replay of active status. Replays retain the persisted event and run IDs. Metadata is transported unchanged and has no package-defined meaning.

Registry schema version 1 is not migrated. When encountered, its records are discarded and an empty version 2 registry is initialized; those old agents cannot be listed or resumed.
