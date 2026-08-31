import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

type ProjectApprovalContext = Pick<ExtensionContext, "isProjectTrusted">;

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
	// Trusted projects skip the per-call confirmation prompt; the trust gate below
	// rejects untrusted projects outright.
	if (!ctx.isProjectTrusted())
		throw new Error("Project-local agents are disabled because this project is not trusted");
}
