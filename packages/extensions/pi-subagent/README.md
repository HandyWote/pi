# pi-subagent

Persistent foreground and background subagents for pi.

This package is independent from task-list extensions. It does not import Todo code or interpret Todo fields. Integrations can pass opaque string metadata and observe the versioned lifecycle event protocol.

## Install

```bash
pi install npm:@handy_wote/pi-subagent
```

The extension registers `agent_start`, `agent_list`, `agent_output`, `agent_stop`, and `agent_resume`, plus the `/agents` command and `--subagent-concurrency` flag. Concurrency defaults to 4 and is capped at 8. Failed agents are never retried automatically.

## Agent Definitions

User agents live in `~/.pi/agent/agents/*.md`. Project agents live in the nearest `.pi/agents/*.md` directory.

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

Project definitions require a trusted project and explicit interactive confirmation on every start. Discovery reads only frontmatter; the prompt body is read after confirmation and its metadata is revalidated before launch.

## Operation

Foreground starts block until all requested agents finish. Background starts return stable IDs immediately and post one completion notification. A batch may contain up to eight items and runs under the same concurrency limit.

`agent_output` can poll or block with a timeout. `agent_stop` preserves partial output. `agent_resume` reuses the stable agent ID and child session; it is the only way to restart terminal work.

State is stored under the pi agent directory in `subagents/`: the registry, JSONL transcripts, child sessions, prompts, and temporary worktrees. On reload, queued work is marked interrupted. A surviving running child is identified by PID plus process start token, terminated, and confirmed gone before its record becomes interrupted.

Worktree isolation uses the persistent branch `pi-subagent/<agentId>`. Terminal cleanup removes the worktree checkout but retains the branch, so explicit resume can attach the same commits.

## Lifecycle Protocol

Lifecycle events are emitted on `pi:agent:lifecycle`:

```ts
interface AgentLifecycleEvent {
	version: 1;
	eventId: string;
	agentId: string;
	parentSessionId: string;
	status: "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";
	timestamp: string;
	metadata: Record<string, string>;
}
```

Consumers may emit `{ version: 1, parentSessionId }` on `pi:agent:status-request` to request replay of active status. Replays retain the persisted event ID. Metadata is transported unchanged and has no package-defined meaning.
