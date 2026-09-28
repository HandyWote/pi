export interface TodoPlanMessageInput {
	source: string;
	plan: string;
}

export function buildTodoPlanMessageContent(input: TodoPlanMessageInput): string {
	return `[PI TODO PLAN]\nSource: ${input.source}\n\n${input.plan.trim()}\n\nConvert this confirmed work into a dependency-aware list with write_todo. Use only pending, in_progress, and completed states. Add review as a normal task only when it is useful. Then call todo_list and atomically claim ready work. When at least two ready tasks are independent and have separate file ownership, pass each claim's metadata unchanged in one worker agent_start batch with mode=background. Use explore only for unbound read-only investigation. Keep small, coupled, or same-file work in the main session. Agent process completion does not complete a Todo; the worker must explicitly complete it after meeting its acceptance criteria.`;
}
