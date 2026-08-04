import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@handy_wote/pi-coding-agent";
import { getBuiltInAgents } from "./built-in-agents.ts";
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

function readProjectFrontmatter(filePath: string): string {
	const handle = fs.openSync(filePath, "r");
	try {
		const byte = Buffer.alloc(1);
		const decoder = new StringDecoder("utf8");
		let content = "";
		let line = "";
		let delimiters = 0;
		let bytesRead = 0;
		while (bytesRead < 65_536 && fs.readSync(handle, byte, 0, 1, null) === 1) {
			bytesRead++;
			const character = decoder.write(byte);
			if (!character) continue;
			content += character;
			line += character;
			if (character !== "\n") continue;
			if (line.trim() === "---") {
				delimiters++;
				if (delimiters === 2) return content;
			}
			line = "";
		}
		if (line.trim() === "---" && delimiters === 1) return content;
		throw new Error("Project agent requires a bounded frontmatter header");
	} finally {
		fs.closeSync(handle);
	}
}

function parseAgentDefinition(
	filePath: string,
	source: AgentSource,
	content: string,
	requirePrompt: boolean,
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter<Partial<AgentFrontmatter>>(content);
	const name = frontmatter.name?.trim();
	const description = frontmatter.description?.trim();
	const isolation = parseIsolation(frontmatter.isolation?.trim());
	if (!name || !description) throw new Error("Agent requires non-empty name and description");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid agent name: ${name}`);
	if (isolation === undefined) throw new Error(`Invalid isolation: ${frontmatter.isolation}`);
	if (requirePrompt && !body.trim()) throw new Error("Agent requires a non-empty system prompt");
	if (frontmatter.model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(frontmatter.model.trim()))
		throw new Error(`Invalid model: ${frontmatter.model}`);
	if (frontmatter.displayName && (frontmatter.displayName.length > 80 || /[\r\n]/.test(frontmatter.displayName)))
		throw new Error("Invalid displayName");
	if (frontmatter.color && !/^(#[0-9A-Fa-f]{6}|[A-Za-z][A-Za-z0-9_-]{0,31})$/.test(frontmatter.color))
		throw new Error(`Invalid color: ${frontmatter.color}`);
	const tools = frontmatter.tools
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (tools?.some((tool) => !/^[A-Za-z0-9_.:-]+$/.test(tool))) throw new Error("Invalid tool name");
	return {
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
	};
}

function definitionIdentity(definition: AgentDefinition): string {
	return JSON.stringify({
		name: definition.name,
		description: definition.description,
		tools: definition.tools,
		model: definition.model,
		source: definition.source,
		filePath: definition.filePath,
		isolation: definition.isolation,
		displayName: definition.displayName,
		color: definition.color,
	});
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
			const content = source === "project" ? readProjectFrontmatter(filePath) : fs.readFileSync(filePath, "utf8");
			agents.push(parseAgentDefinition(filePath, source, content, source === "user"));
		} catch (error: unknown) {
			diagnostics.push({ filePath, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { agents, diagnostics };
}

export function loadAgentPrompt(definition: AgentDefinition): AgentDefinition {
	if (definition.source === "user" || definition.source === "built-in")
		return { ...definition, tools: definition.tools ? [...definition.tools] : undefined };
	const loaded = parseAgentDefinition(
		definition.filePath,
		definition.source,
		fs.readFileSync(definition.filePath, "utf8"),
		true,
	);
	if (definitionIdentity(loaded) !== definitionIdentity(definition))
		throw new Error(`Project agent changed after approval: ${definition.name}`);
	return loaded;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const builtIn = getBuiltInAgents();
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const user = scope === "project" ? { agents: [], diagnostics: [] } : loadAgentsFromDir(userDir, "user");
	const project =
		scope === "user" || !projectAgentsDir
			? { agents: [], diagnostics: [] }
			: loadAgentsFromDir(projectAgentsDir, "project");
	const diagnostics = [...user.diagnostics, ...project.diagnostics];
	const byName = new Map<string, AgentDefinition>();
	for (const agent of builtIn) byName.set(agent.name, agent);
	const userNames = new Set<string>();
	for (const agent of user.agents) {
		if (userNames.has(agent.name))
			diagnostics.push({ filePath: agent.filePath, message: `Duplicate user agent: ${agent.name}` });
		else {
			userNames.add(agent.name);
			byName.set(agent.name, agent);
		}
	}
	const projectNames = new Set<string>();
	for (const agent of project.agents) {
		if (projectNames.has(agent.name)) {
			diagnostics.push({ filePath: agent.filePath, message: `Duplicate project agent: ${agent.name}` });
			continue;
		}
		projectNames.add(agent.name);
		byName.set(agent.name, agent);
	}
	return {
		agents: [...byName.values()],
		diagnostics,
		projectAgentsDir,
	};
}
