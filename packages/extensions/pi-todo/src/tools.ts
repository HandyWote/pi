import type { ExtensionAPI, ExtensionContext } from "@handy_wote/pi-coding-agent";
import { Type } from "typebox";
import type { TodoStore } from "./store.ts";
import type { MarkStatus, NextWaveResult, TodoSummary } from "./types.ts";
import { updateTodoWidget } from "./widget.ts";

const TodoId = Type.String({
	description: "Unique task id, such as T1",
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
});
const SizeHint = Type.Union([Type.Literal("small"), Type.Literal("big")]);
const WriteTodoParamsSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			id: TodoId,
			title: Type.String({ minLength: 1 }),
			depends_on: Type.Array(TodoId),
			acceptance_criteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			size_hint: SizeHint,
			files_in_scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
		{ minItems: 1 },
	),
	global_direction: Type.String({ minLength: 1 }),
});
const MarkParamsSchema = Type.Object({
	id: TodoId,
	status: Type.Union([
		Type.Literal("done"),
		Type.Literal("fix-needed"),
		Type.Literal("off-target"),
		Type.Literal("failed"),
	]),
	note: Type.Optional(Type.String()),
});

function assertMainSession(ctx: ExtensionContext): void {
	if (ctx.getSystemPrompt().includes("<active_agent name=")) {
		throw new Error("pi-todo state can only be changed by the main session");
	}
}

function formatSummary(summary: TodoSummary): string {
	return `done=${summary.done}, pending=${summary.pending}, failed=${summary.failed}, blocked=${summary.blocked}`;
}

function formatWave(result: NextWaveResult, hasAgent: boolean, direction: string): string {
	if (result.waiting)
		return `Wave ${result.wave} is still active. Review and mark its tasks before requesting another wave.`;
	if (result.complete)
		return "No executable tasks remain. Summarize the done, failed, and blocked tasks for the user.";

	const tasks = result.tasks
		.map(
			(task) =>
				`${task.id}: ${task.title}\nAcceptance criteria:\n${task.acceptance_criteria.map((criterion) => `- ${criterion}`).join("\n")}\nSize: ${task.size_hint}${task.files_in_scope ? `\nFiles in scope: ${task.files_in_scope.join(", ")}` : ""}`,
		)
		.join("\n\n");
	if (!hasAgent) {
		return `Wave ${result.wave}\nGlobal direction: ${direction}\n\n${tasks}\n\nThe Agent tool is unavailable. Execute these tasks sequentially in the main session, self-review each one against its acceptance criteria, and call mark after each review.`;
	}

	const descriptions = result.tasks.map((task) => `Agent.description = "pi-todo:${task.id}"`).join("; ");
	return `Wave ${result.wave}\nGlobal direction: ${direction}\n\n${tasks}\n\nDispatch all tasks in this wave in one turn with parallel Agent calls and run_in_background: true. Use the exact descriptions required for lifecycle tracking: ${descriptions}. Include the task id, title, acceptance criteria, files in scope, and global direction in each prompt. After completion, self-review small tasks; use a review subagent for big tasks. Review agents must use descriptions without the pi-todo: prefix. Call mark with the review outcome.`;
}

function formatMarkNextAction(id: string, status: MarkStatus, exhausted: boolean): string {
	if (exhausted) return ` Retry limit exhausted; ${id} is failed.`;
	if (status === "fix-needed") {
		return ` Fix the gap and review again. If using an Agent for the fix, set Agent.description exactly to "pi-todo:${id}".`;
	}
	if (status === "off-target") {
		return ` Revert the off-target changes, then reassign at most once with Agent.description exactly "pi-todo:${id}".`;
	}
	return " Call next_wave after every task in the active wave has been marked.";
}

export function registerTodoTools(pi: ExtensionAPI, store: TodoStore): void {
	pi.registerTool({
		name: "write_todo",
		label: "Write Todo",
		description: "Initialize or replace the pi-todo dependency graph for the current main session",
		promptSnippet: "Create a dependency-aware todo graph from an explicit plan",
		promptGuidelines: [
			"Use write_todo when a [PI TODO PLAN] message asks you to structure a plan, or when the user confirms execution of an existing explicit or implicit plan. Then call next_wave.",
		],
		parameters: WriteTodoParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertMainSession(ctx);
			const items = store.write(params);
			updateTodoWidget(ctx, store);
			return {
				content: [{ type: "text", text: `Initialized ${items.length} tasks. Call next_wave to begin execution.` }],
				details: { items, global_direction: store.getGlobalDirection() },
			};
		},
	});

	pi.registerTool({
		name: "next_wave",
		label: "Next Wave",
		description: "Start the next dependency-ready pi-todo wave after the current wave has been reviewed",
		promptSnippet: "Get the next dependency-ready todo wave",
		promptGuidelines: [
			"Use next_wave only after every task in the current pi-todo wave has been reviewed and marked.",
		],
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			assertMainSession(ctx);
			const result = store.nextWave();
			const hasAgent = pi.getActiveTools().includes("Agent");
			updateTodoWidget(ctx, store);
			return {
				content: [{ type: "text", text: formatWave(result, hasAgent, store.getGlobalDirection()) }],
				details: { ...result, agent_available: hasAgent, global_direction: store.getGlobalDirection() },
			};
		},
	});

	pi.registerTool({
		name: "mark",
		label: "Mark Todo",
		description: "Record the main session's review outcome for one pi-todo task",
		promptSnippet: "Mark a todo review as done, fix-needed, off-target, or failed",
		promptGuidelines: [
			"After executing a pi-todo task, review it against its acceptance criteria and global direction, then use mark. A fix-needed task allows at most two fix/review rounds; an off-target task allows one reassignment.",
		],
		parameters: MarkParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertMainSession(ctx);
			const result = store.mark(params.id, params.status as MarkStatus, params.note);
			updateTodoWidget(ctx, store);
			const nextAction = formatMarkNextAction(params.id, params.status as MarkStatus, result.exhausted);
			return {
				content: [
					{
						type: "text",
						text: `${params.id} is ${result.item.status}. ${formatSummary(result.summary)}.${nextAction}`,
					},
				],
				details: result,
			};
		},
	});
}
