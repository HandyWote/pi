import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
} from "@handy_wote/pi-coding-agent";
import { buildTodoPlanMessageContent } from "./plan-message.ts";
import type { TodoRuntime } from "./runtime.ts";

const RECENT_CONTEXT_ENTRY_LIMIT = 12;
const RECENT_CONTEXT_CHAR_LIMIT = 12000;

const EXECUTION_INTENT_PATTERNS = [
	/按(这个|此|上面|上述|前面)(计划|方案)?(执行|做|实现|推进)/u,
	/按上面的做/u,
	/(开始|继续)(实现|执行|推进|做)/u,
	/^\s*继续(?:吧|执行|做|推进|实现)?[。.!！]?\s*$/u,
	/\b(go ahead|proceed|execute this plan|implement the plan|start implementation|start implementing)\b/i,
	/\b(continue|continue implementation|continue implementing|continue with this|do it|ship it)\b/i,
];

const NON_EXECUTION_PATTERNS = [
	/不要(修改|改|动|实现|执行)/u,
	/别(修改|改|动|实现|执行)/u,
	/\b(do not|don't)\s+(modify|change|edit|implement|execute)\b/i,
	/\b(no|without)\s+(code\s+)?(changes?|modifications?|edits?)\b/i,
	/\b(plan only|proposal only|no implementation)\b/i,
	/^(?:\s*)(?:please\s+)?(?:review|investigate|audit|analy[sz]e|inspect|look into|check)\b/i,
	/^(?:\s*)(?:先)?(?:调查|确认现状|审查|检查|分析)/u,
	/(出|给|制定|写).{0,12}(执行)?(计划|方案)/u,
	/\b(?:make|write|draft|create|give me|propose)\b.{0,30}\b(plan|proposal|approach)\b/i,
];

const PLAN_HEADING_PATTERN = /\b(implementation plan|execution plan|todo plan|task plan|acceptance criteria)\b/i;
const GENERIC_PLAN_HEADING_PATTERN = /(?:^|\n)\s*(?:plan|proposal|approach|方案|计划)\s*:/i;
const CHINESE_PLAN_PATTERN = /(计划|方案|步骤|任务|验收标准)/u;
const PI_TODO_PLAN_PATTERN = /\[PI TODO PLAN\]/;
const TODO_TASK_PATTERN = /(?:^|\n)\s*T\d+[:.)\s-]/i;
const PLAN_LIST_LINE_PATTERN = /(?:^|\n)\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+\S/g;

export function registerTodoAutoTrigger(pi: ExtensionAPI, runtime: TodoRuntime): void {
	pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
		const recovered = await runtime.reconcileOwners();
		if (!isExplicitlyNonExecution(event.prompt) && hasExecutionIntent(event.prompt)) {
			const digest = await runtime.digest();
			if (digest) {
				return { message: { customType: "pi-todo-continuation", content: digest, display: false } };
			}
		}
		if (recovered) {
			const digest = await runtime.digest();
			if (digest) return { message: { customType: "pi-todo-digest", content: digest, display: false } };
		}

		const content = buildAutoPlan(event, ctx);
		if (!content || (await runtime.view())) return undefined;
		return { message: { customType: "pi-todo-plan", content, display: true } };
	});
}

function buildAutoPlan(event: BeforeAgentStartEvent, ctx: ExtensionContext): string | undefined {
	if (isExplicitlyNonExecution(event.prompt) || !hasExecutionIntent(event.prompt)) return undefined;
	const currentPromptHasPlan = hasLikelyPlan(event.prompt);
	const contextText = currentPromptHasPlan ? "" : recentContextText(ctx);
	if (!currentPromptHasPlan && !hasLikelyPlan(contextText)) return undefined;
	const parts = [`Current user execution request:\n${event.prompt.trim()}`];
	parts.push(
		currentPromptHasPlan
			? "The current request contains the plan to execute."
			: `Recent context containing the existing plan:\n${contextText}`,
	);
	return buildTodoPlanMessageContent({
		source: currentPromptHasPlan ? "current prompt" : "recent context",
		plan: parts.join("\n\n"),
	});
}

function hasExecutionIntent(prompt: string): boolean {
	return EXECUTION_INTENT_PATTERNS.some((pattern) => pattern.test(prompt));
}

function isExplicitlyNonExecution(prompt: string): boolean {
	return NON_EXECUTION_PATTERNS.some((pattern) => pattern.test(prompt));
}

function hasLikelyPlan(text: string): boolean {
	const listLineCount = [...text.matchAll(PLAN_LIST_LINE_PATTERN)].length;
	return (
		PI_TODO_PLAN_PATTERN.test(text) ||
		PLAN_HEADING_PATTERN.test(text) ||
		(GENERIC_PLAN_HEADING_PATTERN.test(text) && listLineCount >= 2) ||
		(CHINESE_PLAN_PATTERN.test(text) && listLineCount >= 2) ||
		TODO_TASK_PATTERN.test(text) ||
		listLineCount >= 3
	);
}

function recentContextText(ctx: ExtensionContext): string {
	const text = ctx.sessionManager
		.buildContextEntries()
		.slice(-RECENT_CONTEXT_ENTRY_LIMIT)
		.map(entryText)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
	return text.length > RECENT_CONTEXT_CHAR_LIMIT ? text.slice(-RECENT_CONTEXT_CHAR_LIMIT) : text;
}

function entryText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return messageText(entry.message);
		case "custom_message":
			return typeof entry.content === "string"
				? entry.content
				: entry.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		case "compaction":
		case "branch_summary":
			return entry.summary;
		default:
			return "";
	}
}

function messageText(message: SessionMessageEntry["message"]): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
