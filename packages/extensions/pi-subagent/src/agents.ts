import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@handy_wote/pi-coding-agent";
import type {
	AgentDefinition,
	AgentDiscoveryDiagnostic,
	AgentDiscoveryResult,
	AgentIsolation,
	AgentScope,
	AgentSource,
} from "./types.ts";

interface AgentFrontmatter extends Record<string, string> {
	name: string;
	description: string;
	tools: string;
	model: string;
	isolation: string;
	displayName: string;
	color: string;
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function parseIsolation(value: string | undefined): AgentIsolation | undefined {
	if (value === undefined || value === "none") return "none";
	if (value === "worktree") return "worktree";
	return undefined;
}

function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
): { agents: AgentDefinition[]; diagnostics: AgentDiscoveryDiagnostic[] } {
	const agents: AgentDefinition[] = [];
	const diagnostics: AgentDiscoveryDiagnostic[] = [];
	if (!isDirectory(dir)) return { agents, diagnostics };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error: unknown) {
		diagnostics.push({ filePath: dir, message: error instanceof Error ? error.message : String(error) });
		return { agents, diagnostics };
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf8");
			const { frontmatter, body } = parseFrontmatter<Partial<AgentFrontmatter>>(content);
			const name = frontmatter.name?.trim();
			const description = frontmatter.description?.trim();
			const isolation = parseIsolation(frontmatter.isolation?.trim());
			if (!name || !description) {
				diagnostics.push({ filePath, message: "Agent requires non-empty name and description" });
				continue;
			}
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
				diagnostics.push({ filePath, message: `Invalid agent name: ${name}` });
				continue;
			}
			if (isolation === undefined) {
				diagnostics.push({ filePath, message: `Invalid isolation: ${frontmatter.isolation}` });
				continue;
			}
			const tools = frontmatter.tools
				?.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean);
			if (tools?.some((tool) => !/^[A-Za-z0-9_.:-]+$/.test(tool))) {
				diagnostics.push({ filePath, message: "Invalid tool name" });
				continue;
			}
			agents.push({
				name,
				description,
				tools: tools && tools.length > 0 ? tools : undefined,
				model: frontmatter.model?.trim() || undefined,
				systemPrompt: body.trim(),
				source,
				filePath,
				isolation,
				displayName: frontmatter.displayName?.trim() || undefined,
				color: frontmatter.color?.trim() || undefined,
			});
		} catch (error: unknown) {
			diagnostics.push({ filePath, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { agents, diagnostics };
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const user = scope === "project" ? { agents: [], diagnostics: [] } : loadAgentsFromDir(userDir, "user");
	const project =
		scope === "user" || !projectAgentsDir
			? { agents: [], diagnostics: [] }
			: loadAgentsFromDir(projectAgentsDir, "project");
	const byName = new Map<string, AgentDefinition>();
	for (const agent of user.agents) byName.set(agent.name, agent);
	for (const agent of project.agents) byName.set(agent.name, agent);
	return {
		agents: [...byName.values()],
		diagnostics: [...user.diagnostics, ...project.diagnostics],
		projectAgentsDir,
	};
}
