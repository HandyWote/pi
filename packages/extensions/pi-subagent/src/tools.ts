import type { AgentToolResult } from "@handy_wote/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@handy_wote/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, loadAgentPrompt } from "./agents.ts";
import { approveProjectAgents } from "./approval.ts";
import type { AgentManager } from "./manager.ts";
import { type AgentToolDetails, BoundedText, renderAgentResult } from "./render.ts";
import type { AgentDefinition, AgentIsolation, AgentMode, AgentRecord, AgentScope, StartResult } from "./types.ts";

const AgentScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]);
const AgentModeSchema = Type.Union([Type.Literal("foreground"), Type.Literal("background")]);
const IsolationSchema = Type.Union([Type.Literal("none"), Type.Literal("worktree")]);
const MetadataSchema = Type.Record(Type.String(), Type.String());
const BatchItem = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
	isolation: Type.Optional(IsolationSchema),
	metadata: Type.Optional(MetadataSchema),
});
const StartParams = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(BatchItem, { maxItems: 8 })),
	mode: Type.Optional(AgentModeSchema),
	scope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String()),
	isolation: Type.Optional(IsolationSchema),
	metadata: Type.Optional(MetadataSchema),
});
const AgentIdParams = Type.Object({ agentId: Type.String() });
const OutputParams = Type.Object({
	agentId: Type.String(),
	block: Type.Optional(Type.Boolean()),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
});
const ResumeParams = Type.Object({
	agentId: Type.String(),
	prompt: Type.String(),
	mode: Type.Optional(AgentModeSchema),
});

type ToolResult = AgentToolResult<AgentToolDetails> & { isError?: boolean };

function textResult(text: string, details: AgentToolDetails, isError = false): ToolResult {
	return { content: [{ type: "text", text }], details, isError };
}

function requireManager(getManager: () => AgentManager | undefined): AgentManager {
	const manager = getManager();
	if (!manager) throw new Error("Subagent registry is unavailable for this session");
	return manager;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("Subagent operation was aborted");
	error.name = "AbortError";
	throw error;
}

function validateDefinition(pi: ExtensionAPI, ctx: ExtensionContext, definition: AgentDefinition): void {
	const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
	const unknownTools = definition.tools?.filter((tool) => !availableTools.has(tool)) ?? [];
	if (unknownTools.length > 0)
		throw new Error(`Agent ${definition.name} configures unknown tools: ${unknownTools.join(", ")}`);
	if (!definition.model) return;
	const modelExists = ctx.modelRegistry
		.getAll()
		.some((model) => definition.model === model.id || definition.model === `${model.provider}/${model.id}`);
	if (!modelExists) throw new Error(`Agent ${definition.name} configures unknown model: ${definition.model}`);
}

function outputText(record: AgentRecord, transcript: string, ready: boolean): string {
	const lines = [
		`Agent ${record.agentId}: ${record.status}`,
		`Type: ${record.definition.name}`,
		`Task: ${record.task}`,
		`Output file: ${record.transcriptPath}`,
	];
	if (!ready) lines.push("Result: not_ready");
	if (record.lastOutput) lines.push(`Latest output:\n${record.lastOutput}`);
	if (record.error) lines.push(`Error:\n${record.error.trim()}`);
	if (transcript) lines.push(`Transcript:\n${transcript}`);
	return lines.join("\n");
}

function availableAgentNames(definitions: readonly AgentDefinition[]): string {
	return definitions.length > 0 ? definitions.map((definition) => definition.name).join(", ") : "none";
}

export function registerAgentTools(pi: ExtensionAPI, getManager: () => AgentManager | undefined): void {
	pi.registerTool({
		name: "agent_start",
		label: "Agent",
		description: "Start one or more independent subagents. Background mode returns stable agent IDs immediately.",
		parameters: StartParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				throwIfAborted(signal);
				const manager = requireManager(getManager);
				const hasSingle = Boolean(params.agent && params.task);
				const hasBatch = (params.tasks?.length ?? 0) > 0;
				if (Number(hasSingle) + Number(hasBatch) !== 1)
					throw new Error("Provide exactly one agent/task or a non-empty tasks array");
				const scope: AgentScope = params.scope ?? "user";
				if (scope !== "user" && !ctx.isProjectTrusted())
					throw new Error("Project-local agents are disabled because this project is not trusted");
				const discovery = discoverAgents(ctx.cwd, scope);
				throwIfAborted(signal);
				if (discovery.diagnostics.length > 0) {
					ctx.ui.notify(
						`Skipped invalid agent definitions:\n${discovery.diagnostics.map((item) => `${item.filePath}: ${item.message}`).join("\n")}`,
						"warning",
					);
				}
				const requests = hasBatch
					? (params.tasks ?? [])
					: [
							{
								agent: params.agent ?? "",
								task: params.task ?? "",
								cwd: params.cwd,
								isolation: params.isolation,
								metadata: params.metadata,
							},
						];
				const resolved = requests.map((request) => {
					const definition = discovery.agents.find((agent) => agent.name === request.agent);
					if (!definition)
						throw new Error(
							`Unknown agent: ${request.agent}. Available agents: ${availableAgentNames(discovery.agents)}`,
						);
					return { request, definition };
				});
				await approveProjectAgents(
					resolved.map((item) => item.definition),
					ctx,
				);
				throwIfAborted(signal);
				for (const item of resolved) {
					item.definition = loadAgentPrompt(item.definition);
					validateDefinition(pi, ctx, item.definition);
				}
				const mode: AgentMode = params.mode ?? "foreground";
				const tracked = new Set<string>();
				const unsubscribe = manager.subscribe((event) => {
					if (!tracked.has(event.agentId)) return;
					const records = [...tracked]
						.map((agentId) => manager.get(agentId))
						.filter((record): record is AgentRecord => Boolean(record));
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `${records.filter((record) => isTerminal(record)).length}/${records.length} agents finished`,
							},
						],
						details: { operation: "start", records },
					});
				});
				const starts: StartResult[] = [];
				try {
					for (const { request, definition } of resolved) {
						throwIfAborted(signal);
						const started = await manager.start(definition, {
							task: request.task,
							mode,
							cwd: request.cwd,
							isolation: request.isolation as AgentIsolation | undefined,
							metadata: request.metadata,
							signal,
						});
						tracked.add(started.record.agentId);
						starts.push(started);
						throwIfAborted(signal);
					}
					if (mode === "background") {
						for (const start of starts) start.detachAbort();
						const records = starts.map((start) => start.record);
						return textResult(
							records
								.map(
									(record) =>
										`Launched ${record.definition.name} as ${record.agentId}; output: ${record.transcriptPath}`,
								)
								.join("\n"),
							{ operation: "start", records },
						);
					}
					const records = await Promise.all(starts.map((start) => start.completion));
					const failed = records.some((record) => record.status !== "completed");
					return textResult(
						records.map((record) => outputText(record, "", true)).join("\n\n"),
						{ operation: "start", records },
						failed,
					);
				} finally {
					unsubscribe();
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { operation: "start", records: [], error: message }, true);
			}
		},
		renderCall(args, theme) {
			const count = args.tasks?.length ?? 1;
			const label = count > 1 ? `${count} agents` : (args.agent ?? "agent");
			return new BoundedText(
				`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("accent", label)} ${theme.fg("muted", args.mode ?? "foreground")}`,
			);
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result.details as AgentToolDetails | undefined, options, theme);
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "Agent List",
		description: "List available subagent definitions and execution history for the current parent session.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const projectTrusted = ctx.isProjectTrusted();
				const records = requireManager(getManager)
					.list()
					.filter((record) => projectTrusted || record.definition.source === "user");
				const definitions = discoverAgents(ctx.cwd, projectTrusted ? "both" : "user").agents;
				const definitionSummaries = definitions.map(({ name, source, description }) => ({
					name,
					source,
					description,
				}));
				const sections: string[] = [];
				if (definitions.length > 0)
					sections.push(
						`Available agents:\n${definitions
							.map((definition) => `${definition.name} [${definition.source}]: ${definition.description}`)
							.join("\n")}`,
					);
				if (records.length > 0)
					sections.push(
						`History:\n${records
							.map((record) => `${record.agentId} ${record.status} ${record.definition.name}: ${record.task}`)
							.join("\n")}`,
					);
				return textResult(sections.join("\n\n") || "No agents", {
					operation: "list",
					records,
					definitions: definitionSummaries,
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { operation: "list", records: [], error: message }, true);
			}
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result.details as AgentToolDetails | undefined, options, theme);
		},
	});

	pi.registerTool({
		name: "agent_output",
		label: "Agent Output",
		description: "Read running or terminal agent output. Optionally block until terminal state or timeout.",
		parameters: OutputParams,
		async execute(_toolCallId, params) {
			try {
				const output = await requireManager(getManager).output(
					params.agentId,
					params.block ?? true,
					Math.min(600, Math.max(0, params.timeoutSeconds ?? 30)) * 1000,
				);
				return textResult(outputText(output.record, output.transcript, output.ready), {
					operation: "output",
					records: [output.record],
					transcript: output.transcript,
					ready: output.ready,
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { operation: "output", records: [], error: message }, true);
			}
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result.details as AgentToolDetails | undefined, options, theme);
		},
	});

	pi.registerTool({
		name: "agent_stop",
		label: "Agent Stop",
		description: "Stop one queued or running agent and preserve its partial output.",
		parameters: AgentIdParams,
		async execute(_toolCallId, params) {
			try {
				const record = await requireManager(getManager).stop(params.agentId);
				return textResult(`Stopped ${record.agentId}`, { operation: "stop", records: [record] });
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { operation: "stop", records: [], error: message }, true);
			}
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result.details, options, theme);
		},
	});

	pi.registerTool({
		name: "agent_resume",
		label: "Agent Resume",
		description: "Explicitly resume a terminal agent with new instructions, keeping its stable ID and child session.",
		parameters: ResumeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				throwIfAborted(signal);
				if (!params.prompt.trim()) throw new Error("Resume prompt cannot be empty");
				const manager = requireManager(getManager);
				const current = manager.get(params.agentId);
				if (!current) throw new Error(`Unknown agent: ${params.agentId}`);
				await approveProjectAgents([current.definition], ctx);
				throwIfAborted(signal);
				const started = await manager.resume(params.agentId, params.prompt, params.mode, signal);
				throwIfAborted(signal);
				if ((params.mode ?? started.record.mode) === "background") {
					started.detachAbort();
					return textResult(`Resumed ${started.record.agentId} in background`, {
						operation: "resume",
						records: [started.record],
					});
				}
				const record = await started.completion;
				return textResult(
					outputText(record, "", true),
					{ operation: "resume", records: [record] },
					record.status !== "completed",
				);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { operation: "resume", records: [], error: message }, true);
			}
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result.details as AgentToolDetails | undefined, options, theme);
		},
	});
}

function isTerminal(record: AgentRecord): boolean {
	return (
		record.status === "completed" ||
		record.status === "failed" ||
		record.status === "stopped" ||
		record.status === "interrupted"
	);
}
