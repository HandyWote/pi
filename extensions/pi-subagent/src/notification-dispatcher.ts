import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CustomMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * Delivers terminal notifications to the parent agent.
 *
 * Keeping the host delivery policy here makes the notification batching code
 * independent from the session queue semantics. The host's steer lane wakes
 * an idle parent immediately and queues the message at a tool boundary while
 * the parent is already running.
 */
export interface NotificationDispatcher {
	dispatch(message: CustomMessage): void;
}

export function createNotificationDispatcher(pi: Pick<ExtensionAPI, "sendMessage">): NotificationDispatcher {
	return {
		dispatch(message) {
			pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		},
	};
}
