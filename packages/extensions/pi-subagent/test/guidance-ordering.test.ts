import type { AgentTool } from "@handy_wote/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@handy_wote/pi-ai";
import type { ExtensionAPI } from "@handy_wote/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../coding-agent/src/core/messages.ts";
import { createHarness, type Harness } from "../../../coding-agent/test/suite/harness.ts";
import { injectCoordinatorGuidance } from "../src/swarm.ts";

const GUIDANCE_CUSTOM_TYPE = "pi-subagent-guidance";

describe("swarm coordinator guidance injection ordering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("delivers the guidance after the turn's tool results and before the next assistant response", async () => {
		let pi: ExtensionAPI | undefined;
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				// The coordinator guidance is injected while the tool is still running
				// (e.g. a worker pool is configured mid-turn).
				await toolRelease;
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({
			tools: [slowTool],
			extensionFactories: [
				(p) => {
					pi = p;
				},
			],
		});
		harnesses.push(harness);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("second turn"),
		]);

		const promptPromise = harness.session.prompt("hi");
		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The swarm path queues the guidance for the next explicit prompt.
		injectCoordinatorGuidance(pi!);
		releaseToolExecution?.();
		await promptPromise;

		// The guidance was queued during the run and is not yet in agent state.
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === GUIDANCE_CUSTOM_TYPE,
			),
		).toBe(false);

		// The next explicit prompt drains it alongside the user message, so it
		// lands after the previous turn's tool results and before the next
		// assistant response.
		await harness.session.prompt("and now?");

		const messages = harness.session.messages;
		const guidanceIndex = messages.findIndex(
			(message) => message.role === "custom" && message.customType === GUIDANCE_CUSTOM_TYPE,
		);
		expect(guidanceIndex).toBeGreaterThan(-1);
		expect(messages[guidanceIndex]).toMatchObject({
			role: "custom",
			customType: GUIDANCE_CUSTOM_TYPE,
			display: false,
		});

		// No tool result may appear after the guidance: every tool result still
		// follows its tool call in the replay history.
		const llmMessages = convertToLlm(messages);
		const openToolCallIds = new Set<string>();
		for (const message of llmMessages) {
			if (message.role === "assistant") {
				openToolCallIds.clear();
				for (const block of message.content) {
					if (block.type === "toolCall") openToolCallIds.add(block.id);
				}
				continue;
			}
			if (message.role === "toolResult") {
				expect(openToolCallIds.has(message.toolCallId)).toBe(true);
				openToolCallIds.delete(message.toolCallId);
				continue;
			}
			openToolCallIds.clear();
		}
	});
});
