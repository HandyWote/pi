# Live Extension Message Queue

## Problem

Extensions can currently enqueue custom messages with `steer`, `followUp`, or `nextTurn`, but every queued message is an immutable historical payload. The queue has no identity, replacement, targeted cancellation, or delivery-time validation.

This is incorrect for state-derived notifications. `pi-todo` periodically captures an active Todo digest and enqueues it as a follow-up. Several revisions can accumulate while the agent is busy. After the list is complete, those historical messages still run one at a time and cause unnecessary model turns that only report that the snapshot is stale.

Changing the follow-up mode or suppressing periodic reminders would reduce the symptom without fixing the queue contract. Other extensions that enqueue state-derived notifications would retain the same failure mode.

## Goals

- Give extension-owned queued messages stable identities.
- Replace an older queued message when a newer message has the same identity.
- Cancel one extension-owned message without clearing user messages or unrelated extension messages.
- Resolve state-derived content immediately before delivery.
- Drop a message without starting a model turn when its live resolver reports that it is no longer relevant.
- Make replacement and cancellation win when they race with an asynchronous resolver.
- Apply the same semantics to `steer`, `followUp`, and `nextTurn` delivery.
- Preserve existing unkeyed queue behavior and queue modes.

## Non-Goals

- Persist queued messages across process restarts.
- Deduplicate ordinary user messages.
- Infer message identity from content.
- Change Todo task persistence or lifecycle ownership.

## API

Add an optional live queue descriptor to extension custom-message delivery:

```ts
interface LiveCustomMessageQueue<T> {
	key: string;
	resolve: (
		signal: AbortSignal,
	) =>
		| Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">
		| undefined
		| Promise<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details"> | undefined>;
}

pi.sendMessage(message, {
	deliverAs: "followUp",
	queue: {
		key: `pi-todo:${sessionId}:${listId}`,
		resolve: async (signal) => buildCurrentDigest(signal),
	},
});

pi.cancelMessage(`pi-todo:${sessionId}:${listId}`);
```

The initial message preserves the existing `sendMessage` shape and provides fallback metadata for callers, but a live queue descriptor always requires a resolver and only its resolved result is delivered. A key is scoped to the current session runtime. Enqueuing the same key replaces the older item in every pending delivery queue.

`cancelMessage()` targets only extension messages carrying that key. It does not inspect or clear user queues.

## Queue Semantics

One broker owns keyed entries across `steer`, `followUp`, and `nextTurn` lanes.

1. Enqueue invalidates an older entry with the same key in any lane and appends the new entry to its requested lane.
2. Invalidation aborts the old resolver signal and resolves a separate superseded promise.
3. Drain races the resolver against supersession and run cancellation, so a resolver that ignores its abort signal cannot block a replacement.
4. Before commit, drain verifies that the resolved entry is still the broker's current entry for its key.
5. A resolver result of `undefined` drops the message.
6. Drain restarts from the highest-priority eligible lane after a superseded entry.
7. Drain continues past dropped entries until it finds deliverable messages or the selected lanes are synchronously empty.
8. Only deliverable messages count toward `one-at-a-time` or `all` mode limits.

The synchronous empty check is the delivery boundary. A message enqueued after that check belongs to the next eligible drain.

Resolver failures are isolated like extension event failures: report the extension error, drop the message, and do not fail the active model run.

## Agent Integration

Agent core owns the shared broker. Existing calls without queue options retain FIFO behavior. `Agent.continue()` and loop queue drains await resolution before starting another model turn. A follow-up drain also rechecks steering after a superseded resolver so cross-lane replacement cannot strand the newer message.

The coding-agent session keeps UI queue accounting for ordinary user text unchanged. Extension custom messages use their keyed entries directly and are persisted only after a resolver returns a deliverable message and normal message lifecycle events begin.

`nextTurn` uses the same broker. Its entries resolve to a stable empty boundary before they are added to the next user prompt. Dropped entries never enter session state or model context.

Session replacement, extension reload, and reset invalidate all keyed entries and pending resolvers. Resolver closures from stale extension instances cannot deliver afterward.

## Todo Integration

Each active Todo list uses one queue key containing the parent session ID and list ID. All digest injection paths enqueue a live descriptor rather than an immutable digest:

- periodic turn reminder;
- session fork and tree restoration;
- compaction;
- execution continuation and owner reconciliation where a queued message is used.

The resolver reads the current binding and store view. It returns `undefined` when:

- there is no active list;
- the active list ID differs from the queued list ID;
- all tasks are complete;
- the session runtime has been replaced or shut down.

Replacing, clearing, switching, or fully completing a list also calls targeted cancellation. Cancellation is an eager optimization; delivery-time resolution remains the correctness boundary.

The digest contains the revision read during resolution, so a delivered digest is current at the point it leaves the queue.

## Tests

### Agent Core

- Unkeyed messages preserve FIFO order in both queue modes.
- A keyed message replaces an older keyed message without moving unrelated messages.
- Targeted cancellation leaves unkeyed and differently keyed messages intact.
- A resolver returning `undefined` does not consume the one-at-a-time delivery allowance.
- Replacement and cancellation during an unresolved resolver suppress the old result.
- Cross-lane replacement rechecks higher-priority steering before the drain exits.
- Replacement does not wait for an old resolver that ignores its abort signal.
- Resolver failure is reported and does not terminate the current run.

### Coding Agent

- Keyed extension follow-ups persist only their resolved message.
- A dropped follow-up does not cause a provider call.
- `steer`, `followUp`, and `nextTurn` use equivalent replacement and cancellation rules.
- A `nextTurn` replacement arriving during resolution is included in the prompt currently being built.
- User queue counts and dequeue behavior remain unchanged.
- Extension reload and session replacement invalidate pending live messages.

### pi-todo

- Repeated periodic reminders keep one live Todo message.
- A later revision replaces an earlier revision.
- Completing the list while the resolver is pending produces no Todo model turn.
- Clearing or switching the list suppresses the old list reminder.
- Fork, tree navigation, compaction, and owner reconciliation resolve against the correct list.
- Todo cancellation does not remove subagent lifecycle notifications or user follow-ups.

## Rollout

The extension API addition is optional and does not change existing callers. `pi-todo` adopts the live queue immediately. Changelog entries are required for `agent`, `coding-agent`, and `pi-todo` because the queue primitive, extension API, and user-visible reminder behavior change together.
