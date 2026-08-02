import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEvent,
	ToolCallEventResult,
} from "@handy_wote/pi-coding-agent";
import type { Asker } from "./asker.ts";
import { DenialAudit } from "./audit.ts";
import { parseBashCommand } from "./bash-analysis/index.ts";
import { registerPermissionsCommand } from "./command.ts";
import { registerPermissionFlags } from "./flags.ts";
import { Gate, type GateDependencies } from "./gate.ts";
import { GateHandler } from "./handler.ts";
import { PermissionRuleStore } from "./rules/index.ts";
import { SessionStateImpl } from "./state.ts";

export interface PiPermissionsOptions {
	/** Override the tool-call gate (tests / other UI authors). */
	processToolCall?: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
	/** Inject the auto-mode classifier (wired by the auto-mode milestone). */
	classify?: GateDependencies["classify"];
	/** Custom askers (defaults: TUI select / headless auto-deny). */
	tuiAsker?: Asker;
	headlessAsker?: Asker;
	/** Custom rule store paths (tests). */
	userRulesPath?: string;
	projectRulesPath?: string;
}

export function createPiPermissions(options: PiPermissionsOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const store = new PermissionRuleStore({
			...(options.userRulesPath ? { userRulesPath: options.userRulesPath } : {}),
			...(options.projectRulesPath ? { projectRulesPath: options.projectRulesPath } : {}),
		});
		const gate = new Gate({
			parseBashCommand,
			...(options.classify ? { classify: options.classify } : {}),
		});

		let state: SessionStateImpl | undefined;
		let audit: DenialAudit | undefined;
		let handler: GateHandler | undefined;

		pi.on("session_start", async (_event, ctx) => {
			state = new SessionStateImpl();
			audit = new DenialAudit();
			store.setProjectTrusted(ctx.isProjectTrusted());
			await store.reload();
			handler = new GateHandler({
				store,
				state,
				audit,
				gate,
				...(options.tuiAsker ? { tuiAsker: options.tuiAsker } : {}),
				...(options.headlessAsker ? { headlessAsker: options.headlessAsker } : {}),
			});
		});

		pi.on("session_shutdown", () => {
			store.clearSessionRules();
			state = undefined;
			audit = undefined;
			handler = undefined;
		});

		pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (options.processToolCall) {
				return options.processToolCall(event, ctx);
			}
			if (!handler) {
				// No active session yet: fail closed rather than allow.
				return { block: true, reason: "pi-permissions: no active session, permission check unavailable" };
			}
			return handler.process(event, ctx);
		});

		registerPermissionFlags(pi, store, () => state);
		registerPermissionsCommand(pi, { store: () => store, state: () => state });
	};
}

export default createPiPermissions();
