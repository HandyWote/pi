import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@handy_wote/pi-coding-agent";
import { registerAgentsCommand } from "./command.ts";
import { AgentManager, type AgentManagerOptions, readWorkerModels } from "./manager.ts";
import { registerAgentPanel, registerNotificationCard } from "./render.ts";
import { injectCoordinatorGuidance, registerSwarmCommand } from "./swarm.ts";
import { registerAgentTools } from "./tools.ts";
import {
	AGENT_PROTOCOL_CHANNEL,
	type AgentLifecycleEvent,
	type AgentRecord,
	type AgentTerminalEventDetails,
} from "./types.ts";

const AGENT_STATUS_REQUEST_CHANNEL = "pi:agent:status-request";
const TERMINAL_SUMMARY_LIMIT = 1200;
const TASK_SUMMARY_LIMIT = 160;
const NOTIFICATION_DEBOUNCE_MS = 3000;

interface TerminalNotification {
	record: AgentRecord;
	event: AgentLifecycleEvent;
}

function isStatusRequest(data: unknown): data is { version: 2; parentSessionId: string } {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 2 &&
		"parentSessionId" in data &&
		typeof data.parentSessionId === "string"
	);
}

function terminalNotificationContent(records: AgentRecord[]): string {
	const [record] = records;
	if (record === undefined || records.length === 1) return singleTerminalNotificationContent(record);
	const sections = records.map((entry, index) => {
		const hint = actionHint(entry);
		return `${index + 1}. Subagent ${entry.agentId} (${entry.definition.name}) ${entry.status}. Task: ${taskSummary(entry.task)}. ${hint}.`;
	});
	return [`${records.length} subagents reached terminal state. Before acting, call agent_list.`, ...sections].join(
		"\n",
	);
}

function singleTerminalNotificationContent(record: AgentRecord | undefined): string {
	if (record === undefined) return "No subagent lifecycle events recorded.";
	return [
		`Agent "${record.definition.description}" ${record.status}.`,
		`Task: ${taskSummary(record.task)}`,
		`${actionHint(record)}. Before acting, call agent_list.`,
	].join("\n");
}

function actionHint(record: AgentRecord): string {
	return record.status === "completed" ? "Result available via agent_list" : "Stop: do not resume";
}

function taskSummary(task: string): string {
	return truncate(task.split("\n")[0]!, TASK_SUMMARY_LIMIT);
}

function terminalEventDetails(record: AgentRecord): AgentTerminalEventDetails {
	const output = record.lastOutput || record.error;
	return {
		agentId: record.agentId,
		runId: record.runId,
		definition: record.definition.name,
		status: record.status as AgentTerminalEventDetails["status"],
		task: record.task,
		result: output ? truncate(output, TERMINAL_SUMMARY_LIMIT) : undefined,
		usage: {
			input: record.usage.input,
			output: record.usage.output,
			cost: record.usage.cost,
			toolCount: record.toolCount,
		},
		transcriptPath: record.transcriptPath,
		worktreePath: record.worktreePath,
	};
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export interface PiSubagentExtensionOptions {
	createManager?: (options: AgentManagerOptions) => AgentManager;
	/** Window in milliseconds during which terminal notifications are batched into one event message. */
	notificationDebounceMs?: number;
}

export function createPiSubagent(options: PiSubagentExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		let manager: AgentManager | undefined;
		let currentContext: ExtensionContext | undefined;
		let notificationBatch: TerminalNotification[] = [];
		let notificationTimer: ReturnType<typeof setTimeout> | undefined;
		let coordinatorGuidanceInjected = false;
		const notificationDebounceMs = Math.max(0, options.notificationDebounceMs ?? NOTIFICATION_DEBOUNCE_MS);

		// The coordinator rules belong to the session: a session that starts with
		// an existing pool gets them at start, one that configures the pool later
		// gets them on the first save. Either way exactly once per session.
		const ensureCoordinatorGuidance = () => {
			if (coordinatorGuidanceInjected) return;
			coordinatorGuidanceInjected = true;
			injectCoordinatorGuidance(pi);
		};

		const updateStatus = () => {
			if (!currentContext) return;
			const active =
				manager?.list().filter((record) => record.status === "queued" || record.status === "running").length ?? 0;
			currentContext.ui.setStatus(
				"pi-subagent",
				active > 0 ? `${active} local agent${active === 1 ? "" : "s"}` : undefined,
			);
			registerAgentPanel(currentContext, manager);
		};

		const flushTerminalNotifications = () => {
			if (notificationTimer !== undefined) {
				clearTimeout(notificationTimer);
				notificationTimer = undefined;
			}
			const batch = notificationBatch;
			notificationBatch = [];
			if (batch.length === 0 || !currentContext) return;
			try {
				pi.sendMessage(
					{
						customType: "pi-subagent-notification",
						content: terminalNotificationContent(batch.map((entry) => entry.record)),
						display: true,
						details:
							batch.length === 1
								? terminalEventDetails(batch[0]!.record)
								: batch.map((entry) => terminalEventDetails(entry.record)),
					},
					{ triggerTurn: true, deliverAs: "event" },
				);
			} catch {
				// Notifications are advisory; batching failures must not break agent completion.
			}
		};

		const notifyTerminal = (record: AgentRecord, event: AgentLifecycleEvent) => {
			const context = currentContext;
			if (!context) return;
			context.ui.notify(
				`${record.definition.name} ${record.status}: ${record.task}`,
				record.status === "completed" ? "info" : "warning",
			);
			notificationBatch.push({ record, event });
			if (notificationTimer !== undefined) clearTimeout(notificationTimer);
			notificationTimer = setTimeout(flushTerminalNotifications, notificationDebounceMs);
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
				const pool = await readWorkerModels(manager.rootDir);
				if (pool.length > 0) ensureCoordinatorGuidance();
			} catch (error: unknown) {
				manager = undefined;
				ctx.ui.notify(`Cannot restore subagents: ${error instanceof Error ? error.message : error}`, "error");
			}
		});

		pi.on("session_shutdown", async () => {
			await manager?.destroy();
			flushTerminalNotifications();
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
		registerSwarmCommand(pi, () => manager, ensureCoordinatorGuidance);
		registerNotificationCard(pi);
	};
}

export default createPiSubagent();

export type {
	AgentDefinition,
	AgentLifecycleEvent,
	AgentMode,
	AgentRecord,
	AgentStatus,
	AgentTerminalEventDetails,
	AgentTerminalStatus,
} from "./types.ts";
export { AGENT_PROTOCOL_CHANNEL, AGENT_PROTOCOL_VERSION } from "./types.ts";
// Exported for notification format tests.
export { actionHint, terminalNotificationContent };
