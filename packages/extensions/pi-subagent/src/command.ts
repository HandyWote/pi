import type { ExtensionAPI, ExtensionCommandContext } from "@handy_wote/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { approveProjectAgents } from "./approval.ts";
import type { AgentManager } from "./manager.ts";
import { formatAgentRow } from "./render.ts";
import type { AgentRecord } from "./types.ts";

function describe(record: AgentRecord): string {
	const lines = [
		`${record.definition.name} > ${record.task}`,
		`ID: ${record.agentId}`,
		`Status: ${record.status}`,
		`Tools: ${record.toolCount}`,
		`Tokens: ${record.usage.input + record.usage.output}`,
		`Output: ${record.transcriptPath}`,
	];
	if (record.lastOutput) lines.push(`Latest:\n${record.lastOutput}`);
	if (record.error) lines.push(`Error:\n${record.error.trim()}`);
	return lines.join("\n");
}

async function manageAgent(manager: AgentManager, record: AgentRecord, ctx: ExtensionCommandContext): Promise<void> {
	const actions = ["Inspect output"];
	if (record.status === "queued" || record.status === "running") actions.push("Stop");
	else actions.push("Resume");
	actions.push("Close");
	const action = await ctx.ui.select(`${record.definition.name} > ${record.task}`, actions);
	if (action === "Inspect output") {
		const output = await manager.output(record.agentId, false, 0);
		ctx.ui.notify(
			`${describe(output.record)}${output.transcript ? `\n\n${output.transcript}` : ""}`,
			output.record.status === "failed" ? "error" : "info",
		);
	} else if (action === "Stop") {
		const stopped = await manager.stop(record.agentId);
		ctx.ui.notify(`${stopped.agentId} stopped`, "info");
	} else if (action === "Resume") {
		await approveProjectAgents([record.definition], ctx);
		const prompt = await ctx.ui.input("Resume agent", "Additional instructions");
		if (!prompt?.trim()) return;
		const resumed = await manager.resume(record.agentId, prompt, "background");
		ctx.ui.notify(`${resumed.record.agentId} resumed in background`, "info");
	}
}

export function registerAgentsCommand(pi: ExtensionAPI, getManager: () => AgentManager | undefined): void {
	pi.registerCommand("agents", {
		description: "List, inspect, stop, or resume subagents",
		handler: async (args, ctx) => {
			const manager = getManager();
			if (!manager) {
				ctx.ui.notify("Subagent registry is unavailable", "error");
				return;
			}
			const requestedId = args.trim();
			const projectTrusted = ctx.isProjectTrusted();
			const definitions = discoverAgents(ctx.cwd, projectTrusted ? "both" : "user").agents;
			const availableNames = definitions.map((definition) => definition.name).join(", ") || "none";
			if (requestedId) {
				const record = manager.get(requestedId);
				if (!record || (!projectTrusted && record.definition.source === "project"))
					ctx.ui.notify(`Unknown agent: ${requestedId}. Available agents: ${availableNames}`, "error");
				else await manageAgent(manager, record, ctx);
				return;
			}
			const records = manager.list().filter((record) => projectTrusted || record.definition.source === "user");
			if (records.length === 0 && definitions.length === 0) {
				ctx.ui.notify("No agents", "info");
				return;
			}
			if (!ctx.hasUI) {
				const lines = definitions.map(
					(definition) => `${definition.name} [${definition.source}]: ${definition.description}`,
				);
				lines.push(...records.map((record) => formatAgentRow(record, 120)));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const definitionChoices = definitions.map(
				(definition) => `${definition.name} [${definition.source}] | ${definition.description}`,
			);
			const historyChoices = records.map((record) => `${formatAgentRow(record, 100)} | ${record.agentId}`);
			const choices = [...definitionChoices, ...historyChoices];
			const selected = await ctx.ui.select("Agents", choices);
			const selectedIndex = selected ? choices.indexOf(selected) : -1;
			if (selectedIndex >= 0 && selectedIndex < definitions.length) {
				const definition = definitions[selectedIndex];
				if (definition)
					ctx.ui.notify(`${definition.name} [${definition.source}]\n${definition.description}`, "info");
				return;
			}
			const historyIndex = selectedIndex - definitions.length;
			if (historyIndex >= 0) {
				const record = records[historyIndex];
				if (record) await manageAgent(manager, record, ctx);
			}
		},
	});
}
