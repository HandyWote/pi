import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
} from "@handy_wote/pi-coding-agent";
import { buildTodoPlanMessageContent } from "./plan-message.ts";
import type { TodoStore } from "./store.ts";

const RECENT_CONTEXT_ENTRY_LIMIT = 12;
const RECENT_CONTEXT_CHAR_LIMIT = 12000;

const EXECUTION_INTENT_PATTERNS = [
	/按(这个|此|上面|上述|前面)(计划|方案)?(执行|做|实现|推进)/u,
	/按上面的做/u,
	/(开始|继续)(实现|执行|推进|做)/u,
	/\b(go ahead|proceed|execute this plan|implement the plan|start implementation|start implementing)\b/i,
	/\b(continue implementation|continue implementing|continue with this|do it|ship it)\b/i,
];

const NON_EXECUTION_PATTERNS = [
	/不要(修改|改|动|实现|执行)/u,
	/别(修改|改|动|实现|执行)/u,
	/\b(do not|don't)\s+(modify|change|edit|implement|execute)\b/i,
	/\b(no|without)\s+(code\s+)?(changes?|modifications?|edits?)\b/i,
	/\b(plan only|proposal only|no implementation)\b/i,
	/^(?:\s*)(?:please\s+)?(?:review|investigate|audit|analy[sz]e|inspect|look into|check)\b/i,
	/\b(?:first|for now|only|just)\b.{0,24}\b(?:review|investigate|audit|analy[sz]e|inspect|check)\b/i,
	/\b(?:go ahead|proceed|continue|do it)\b.{0,40}\b(?:review|investigate|audit|analy[sz]e|inspect|check)\b/i,
	/\b(?:review|investigate|audit|analy[sz]e|inspect|check)\b.{0,40}\b(?:go ahead|proceed|continue|do it)\b/i,
	/^(?:\s*)(?:先)?(?:调查|确认现状|审查|检查|分析)/u,
	/(?:继续|开始|按.{0,8})(?:调查|确认现状|审查|检查|分析)/u,
	/(出|给|制定|写).{0,12}(执行)?(计划|方案)/u,
	/\b(?:make|write|draft|create|give me|propose)\b.{0,30}\b(plan|proposal|approach)\b/i,
];

const PLAN_HEADING_PATTERN = /\b(implementation plan|execution plan|todo plan|task plan|acceptance criteria)\b/i;
const GENERIC_PLAN_HEADING_PATTERN = /(?:^|\n)\s*(?:plan|proposal|approach|方案|计划)\s*:/i;
const CHINESE_PLAN_PATTERN = /(计划|方案|步骤|任务|验收标准)/u;
const PI_TODO_PLAN_PATTERN = /\[PI TODO PLAN\]/;
const TODO_TASK_PATTERN = /(?:^|\n)\s*T\d+[:.)\s-]/i;
const PLAN_LIST_LINE_PATTERN = /(?:^|\n)\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+\S/g;

function hasExecutionIntent(prompt: string): boolean {
	return EXECUTION_INTENT_PATTERNS.some((pattern) => pattern.test(prompt));
}

function isExplicitlyNonExecution(prompt: string): boolean {
	return NON_EXECUTION_PATTERNS.some((pattern) => pattern.test(prompt));
}

function hasLikelyPlan(text: string): boolean {
	const listLineCount = countPlanListLines(text);
	if (PI_TODO_PLAN_PATTERN.test(text)) return true;
	if (PLAN_HEADING_PATTERN.test(text)) return true;
	if (GENERIC_PLAN_HEADING_PATTERN.test(text) && listLineCount >= 2) return true;
	if (CHINESE_PLAN_PATTERN.test(text) && listLineCount >= 2) return true;
	if (TODO_TASK_PATTERN.test(text)) return true;
	return listLineCount >= 3;
}

function countPlanListLines(text: string): number {
	return [...text.matchAll(PLAN_LIST_LINE_PATTERN)].length;
}

function messageText(message: SessionMessageEntry["message"]): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function entryText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return messageText(entry.message);
		case "custom_message":
			if (typeof entry.content === "string") return entry.content;
			return entry.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		case "compaction":
		case "branch_summary":
			return entry.summary;
		default:
			return "";
	}
}

function recentContextText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.buildContextEntries().slice(-RECENT_CONTEXT_ENTRY_LIMIT);
	const text = entries
		.map(entryText)
		.map((textPart) => textPart.trim())
		.filter((textPart) => textPart.length > 0)
		.join("\n\n---\n\n");
	return text.length > RECENT_CONTEXT_CHAR_LIMIT ? text.slice(-RECENT_CONTEXT_CHAR_LIMIT) : text;
}

function hasActiveTodoGraph(store: TodoStore): boolean {
	if (!store.hasPlan()) return false;
	const summary = store.getSummary();
	return summary.done < summary.total;
}

function buildAutoPlan(event: BeforeAgentStartEvent, ctx: ExtensionContext, store: TodoStore): string | undefined {
	if (hasActiveTodoGraph(store)) return undefined;
	if (isExplicitlyNonExecution(event.prompt)) return undefined;
	if (!hasExecutionIntent(event.prompt)) return undefined;

	const currentPromptHasPlan = hasLikelyPlan(event.prompt);
	const contextText = currentPromptHasPlan ? "" : recentContextText(ctx);
	if (!currentPromptHasPlan && !hasLikelyPlan(contextText)) return undefined;

	const parts = [`Current user execution request:\n${event.prompt.trim()}`];
	if (currentPromptHasPlan) {
		parts.push("The current request contains the plan to execute.");
	} else {
		parts.push(`Recent context containing the existing plan:\n${contextText}`);
	}

	return buildTodoPlanMessageContent({
		source: currentPromptHasPlan ? "current prompt" : "recent context",
		plan: parts.join("\n\n"),
	});
}

export function registerTodoAutoTrigger(pi: ExtensionAPI, store: TodoStore): void {
	pi.on("before_agent_start", (event, ctx): BeforeAgentStartEventResult | undefined => {
		const content = buildAutoPlan(event, ctx, store);
		if (!content) return undefined;
		return {
			message: {
				customType: "pi-todo-plan",
				content,
				display: true,
			},
		};
	});
}
