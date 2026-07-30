import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

type ProjectApprovalContext = Pick<ExtensionContext, "hasUI" | "isProjectTrusted" | "ui">;

export async function approveProjectAgents(
	definitions: readonly AgentDefinition[],
	ctx: ProjectApprovalContext,
): Promise<void> {
	const projectAgentNames = [
		...new Set(
			definitions.filter((definition) => definition.source === "project").map((definition) => definition.name),
		),
	];
	if (projectAgentNames.length === 0) return;
	if (!ctx.isProjectTrusted())
		throw new Error("Project-local agents are disabled because this project is not trusted");
	if (!ctx.hasUI) throw new Error("Project-local agents require interactive confirmation");
	const approved = await ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${projectAgentNames.join(", ")}\n\nProject agents are repository-controlled.`,
	);
	if (!approved) throw new Error("Project-local agents were not approved");
}
