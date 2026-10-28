import type { BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TODO_DIGEST_MESSAGE, type TodoRuntime } from "./runtime.ts";

/**
 * Reconciles agent task ownership before each run and re-injects the active
 * digest when recovery changed ownership. Lists are created only through the
 * explicit /todo command or by the model calling the todo tools directly;
 * no prompt keyword triggers todo creation or continuation.
 */
export function registerTodoReconciler(pi: ExtensionAPI, runtime: TodoRuntime): void {
	pi.on("before_agent_start", async (): Promise<BeforeAgentStartEventResult | undefined> => {
		const recovered = await runtime.reconcileOwners();
		if (!recovered) return undefined;
		const digest = await runtime.digest();
		if (!digest) return undefined;
		return { message: { customType: TODO_DIGEST_MESSAGE, content: digest, display: false } };
	});
}
