import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@handy_wote/pi-coding-agent";
import { registerAgentsCommand } from "./command.ts";
import { AgentManager, type AgentManagerOptions } from "./manager.ts";
import { registerAgentTools } from "./tools.ts";
import { AGENT_PROTOCOL_CHANNEL, type AgentLifecycleEvent, type AgentRecord } from "./types.ts";

const AGENT_STATUS_REQUEST_CHANNEL = "pi:agent:status-request";
const TERMINAL_SUMMARY_LIMIT = 1200;

function isStatusRequest(data: unknown): data is { version: 1; parentSessionId: string } {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"parentSessionId" in data &&
		typeof data.parentSessionId === "string"
	);
}

function terminalNotificationContent(record: AgentRecord): string {
	const summary = truncate(record.lastOutput || record.error || "No output", TERMINAL_SUMMARY_LIMIT);
	return [
		"Subagent lifecycle event recorded. It is historical and may have been superseded by later events.",
		`Subagent ${record.agentId} (${record.definition.name}) ${record.status}.`,
		`Task: ${record.task}`,
		`Recorded result: ${summary}`,
		`Usage: ${record.toolCount} tools, ${record.usage.input + record.usage.output} tokens`,
		`Output: ${record.transcriptPath}`,
		"Before acting, call agent_list. If Todo tools are available, call todo_list. Use agent_output for durable output; do not recreate work from this notification alone.",
	].join("\n");
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export interface PiSubagentExtensionOptions {
	createManager?: (options: AgentManagerOptions) => AgentManager;
}

export function createPiSubagent(options: PiSubagentExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		let manager: AgentManager | undefined;
		let currentContext: ExtensionContext | undefined;

		const updateStatus = () => {
			if (!currentContext) return;
			const active =
				manager?.list().filter((record) => record.status === "queued" || record.status === "running").length ?? 0;
			currentContext.ui.setStatus(
				"pi-subagent",
				active > 0 ? `${active} local agent${active === 1 ? "" : "s"}` : undefined,
			);
		};

		const notifyTerminal = (record: AgentRecord, event: AgentLifecycleEvent) => {
			const context = currentContext;
			if (!context) return;
			context.ui.notify(
				`${record.definition.name} ${record.status}: ${record.task}`,
				record.status === "completed" ? "info" : "warning",
			);
			pi.sendMessage(
				{
					customType: "pi-subagent-notification",
					content: terminalNotificationContent(record),
					display: true,
					details: event,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		};

		pi.on("session_start", async (_event, ctx) => {
			currentContext = ctx;
			const concurrencyFlag = pi.getFlag("subagent-concurrency");
			const concurrency = typeof concurrencyFlag === "string" ? Number(concurrencyFlag) : 4;
			const managerOptions: AgentManagerOptions = {
				rootDir: path.join(getAgentDir(), "subagents"),
				parentSessionId: ctx.sessionManager.getSessionId(),
				defaultCwd: ctx.cwd,
				concurrency: Number.isFinite(concurrency) ? concurrency : 4,
				onLifecycle: (event) => {
					pi.events.emit(AGENT_PROTOCOL_CHANNEL, event);
					updateStatus();
				},
				onTerminal: notifyTerminal,
			};
			const next = options.createManager?.(managerOptions) ?? new AgentManager(managerOptions);
			try {
				await next.initialize();
				manager = next;
				updateStatus();
			} catch (error: unknown) {
				manager = undefined;
				ctx.ui.notify(`Cannot restore subagents: ${error instanceof Error ? error.message : error}`, "error");
			}
		});

		pi.on("session_shutdown", async () => {
			await manager?.shutdown();
			manager = undefined;
			currentContext = undefined;
		});

		pi.events.on(AGENT_STATUS_REQUEST_CHANNEL, (data) => {
			if (!manager || !isStatusRequest(data) || data.parentSessionId !== manager.registry.parentSessionId) return;
			manager.republishActive();
		});

		pi.registerFlag("subagent-concurrency", {
			description: "Maximum concurrent local subagents (1-8)",
			type: "string",
			default: "4",
		});
		registerAgentTools(pi, () => manager);
		registerAgentsCommand(pi, () => manager);
	};
}

export default createPiSubagent();

export type {
	AgentDefinition,
	AgentLifecycleEvent,
	AgentMode,
	AgentRecord,
	AgentStatus,
} from "./types.ts";
export { AGENT_PROTOCOL_CHANNEL, AGENT_PROTOCOL_VERSION } from "./types.ts";
