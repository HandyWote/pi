export interface TodoPlanMessageInput {
	source: string;
	plan: string;
}

export function buildTodoPlanMessageContent(input: TodoPlanMessageInput): string {
	return `[PI TODO PLAN]\nSource: ${input.source}\n\n${input.plan.trim()}\n\nConvert this confirmed work into a dependency-aware list with write_todo. Use only pending, in_progress, and completed states. Add review as a normal task only when it is useful. Then call todo_list, atomically claim ready work, and execute independent tasks in parallel when an agent capability is available.`;
}
