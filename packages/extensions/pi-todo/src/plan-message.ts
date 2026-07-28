export interface TodoPlanMessageInput {
	source: string;
	plan: string;
}

export function buildTodoPlanMessageContent(input: TodoPlanMessageInput): string {
	return `[PI TODO PLAN]\nSource: ${input.source}\n\n${input.plan.trim()}\n\nConvert this plan into a dependency-aware todo graph by calling write_todo. Preserve the plan's intent in global_direction and give every task concrete acceptance criteria. Then call next_wave and execute the returned work.`;
}
