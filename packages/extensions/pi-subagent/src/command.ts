import type { ExtensionAPI, ExtensionCommandContext } from "@handy_wote/pi-coding-agent";
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
			if (requestedId) {
				const record = manager.get(requestedId);
				if (!record) ctx.ui.notify(`Unknown agent: ${requestedId}`, "error");
				else await manageAgent(manager, record, ctx);
				return;
			}
			const records = manager.list();
			if (records.length === 0) {
				ctx.ui.notify("No agents", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(records.map((record) => formatAgentRow(record, 120)).join("\n"), "info");
				return;
			}
			const choices = records.map((record) => `${formatAgentRow(record, 100)} | ${record.agentId}`);
			const selected = await ctx.ui.select("Agents", choices);
			const index = selected ? choices.indexOf(selected) : -1;
			if (index >= 0) await manageAgent(manager, records[index], ctx);
		},
	});
}
