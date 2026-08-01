import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEvent,
	ToolCallEventResult,
} from "@handy_wote/pi-coding-agent";

export interface PiPermissionsOptions {
	/**
	 * Override the tool-call gate. Intended for tests and for other UI
	 * authors to plug in their own decision pipeline. Defaults to the
	 * built-in gate (returns undefined = allow).
	 */
	processToolCall?: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
}

export function createPiPermissions(options: PiPermissionsOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const process = options.processToolCall ?? processToolCall;

		// The single mount point for the security gate: fires before every
		// tool executes. Returning { block: true, reason } rejects the tool
		// call (the reason is returned to the model as an error result).
		pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			return process(event, ctx);
		});
	};
}

/**
 * Default gate. Skeleton milestone: always allow. The decision engine
 * (rules, redlines, bash analysis, classifier) plugs in here.
 */
export async function processToolCall(
	_event: ToolCallEvent,
	_ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	return undefined;
}

export default createPiPermissions();
