export const AGENT_PROTOCOL_CHANNEL = "pi:agent:lifecycle";
export const AGENT_PROTOCOL_VERSION = 1;

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";
export type AgentIsolation = "none" | "worktree";
export type AgentMode = "foreground" | "background";
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	isolation: AgentIsolation;
	displayName?: string;
	color?: string;
}

export interface AgentDiscoveryDiagnostic {
	filePath: string;
	message: string;
}

export interface AgentDiscoveryResult {
	agents: AgentDefinition[];
	diagnostics: AgentDiscoveryDiagnostic[];
	projectAgentsDir: string | null;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface AgentActivity {
	type: "text" | "tool";
	text: string;
	timestamp: number;
}

export interface AgentRecord {
	version: 1;
	agentId: string;
	parentSessionId: string;
	definition: AgentDefinition;
	task: string;
	mode: AgentMode;
	status: AgentStatus;
	cwd: string;
	isolation: AgentIsolation;
	metadata: Record<string, string>;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	updatedAt: string;
	childSessionId: string;
	childSessionDir: string;
	childSessionPath?: string;
	transcriptPath: string;
	worktreePath?: string;
	cleanupError?: string;
	pid?: number;
	exitCode?: number;
	model?: string;
	usage: AgentUsage;
	toolCount: number;
	lastOutput: string;
	error?: string;
	activities: AgentActivity[];
	notified: boolean;
	lifecycleEventId: string;
}

export interface AgentLifecycleEvent {
	version: 1;
	eventId: string;
	agentId: string;
	parentSessionId: string;
	status: AgentStatus;
	timestamp: string;
	metadata: Record<string, string>;
}

export interface AgentInvocation {
	agent: string;
	task: string;
	mode: AgentMode;
	scope: AgentScope;
	confirmProjectAgents: boolean;
	cwd?: string;
	isolation?: AgentIsolation;
	metadata: Record<string, string>;
}

export interface StartResult {
	record: AgentRecord;
	completion: Promise<AgentRecord>;
}

export interface AgentOutput {
	record: AgentRecord;
	transcript: string;
	ready: boolean;
}

export function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function isTerminalStatus(status: AgentStatus): boolean {
	return status === "completed" || status === "failed" || status === "stopped" || status === "interrupted";
}
