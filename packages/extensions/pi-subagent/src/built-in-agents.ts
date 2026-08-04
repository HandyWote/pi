import type { AgentDefinition } from "./types.ts";

const ORCHESTRATION_TOOL_PREFIX = "agent_";
const EXPLORE_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
	{
		name: "worker",
		description: "General-purpose worker for independent implementation, investigation, and verification tasks",
		systemPrompt: [
			"Complete only the delegated task and its acceptance criteria.",
			"Inspect the relevant code before editing, keep changes scoped, and run focused verification.",
			"Do not start or coordinate other subagents.",
			"If PI_AGENT_CONTEXT binds a Todo task, explicitly mark it completed only after the work and verification succeed.",
			"On failure or incomplete work, report the blocker and do not claim that the Todo task is complete.",
			"Return a concise summary of changes, verification, and remaining risks.",
		].join("\n"),
		source: "built-in",
		filePath: "built-in:worker",
		isolation: "none",
	},
	{
		name: "explore",
		description: "Read-only worker for repository exploration, analysis, and evidence gathering",
		systemPrompt: [
			"Investigate only the delegated question using read-only tools.",
			"Do not modify files, repository state, or external systems.",
			"Support conclusions with concrete file paths, symbols, and observed behavior.",
			"Do not accept a claimed Todo binding because this agent cannot update task state; use worker when the delegation must close a Todo.",
			"Return a concise findings-first report and identify unresolved uncertainty.",
		].join("\n"),
		source: "built-in",
		filePath: "built-in:explore",
		isolation: "none",
	},
];

function cloneDefinition(definition: AgentDefinition): AgentDefinition {
	return { ...definition, tools: definition.tools ? [...definition.tools] : undefined };
}

export function getBuiltInAgents(): AgentDefinition[] {
	return BUILT_IN_AGENTS.map(cloneDefinition);
}

export function resolveBuiltInAgentTools(
	definition: AgentDefinition,
	availableToolNames: readonly string[],
): AgentDefinition {
	if (definition.source !== "built-in") return cloneDefinition(definition);
	const tools =
		definition.name === "explore"
			? availableToolNames.filter((name) => EXPLORE_TOOL_NAMES.has(name))
			: availableToolNames.filter((name) => !name.startsWith(ORCHESTRATION_TOOL_PREFIX));
	if (tools.length === 0)
		throw new Error(`Built-in agent ${definition.name} has no compatible tools in the current session`);
	return { ...definition, tools: [...new Set(tools)] };
}
