import type { AgentTool } from "@handy_wote/pi-agent-core";
import type { ToolResultMessage } from "@handy_wote/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@handy_wote/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@handy_wote/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../../../coding-agent/test/suite/harness.ts";
import piTodo from "../src/index.ts";

const AgentParams = Type.Object({
	description: Type.String(),
	prompt: Type.String(),
	run_in_background: Type.Boolean(),
});

function getToolResults(messages: readonly unknown[], toolName: string): ToolResultMessage<unknown>[] {
	return messages.filter(
		(message): message is ToolResultMessage<unknown> =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "toolResult" &&
			"toolName" in message &&
			message.toolName === toolName,
	);
}

describe("pi-todo end-to-end", () => {
	it("runs /todo through the faux provider, Agent events, waves, reviews, and widget", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const dispatches: string[] = [];
		const widgetFrames: string[][] = [];

		const agentTool: AgentTool<typeof AgentParams, { agentId: string }> = {
			name: "Agent",
			label: "Agent",
			description: "Deterministic pi-subagents replacement for the test",
			parameters: AgentParams,
			executionMode: "parallel",
			execute: async (_toolCallId, params) => {
				if (!extensionApi) throw new Error("Extension API is unavailable");
				const agentId = `agent-${dispatches.length + 1}`;
				dispatches.push(params.description);
				extensionApi.events.emit("subagents:created", {
					id: agentId,
					description: params.description,
					isBackground: params.run_in_background,
				});
				extensionApi.events.emit("subagents:completed", {
					id: agentId,
					description: params.description,
					status: "completed",
				});
				return {
					content: [{ type: "text", text: `${params.description} completed` }],
					details: { agentId },
				};
			},
		};

		const harness = await createHarness({
			tools: [agentTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					piTodo(pi);
				},
			],
		});
		const uiContext = {
			setWidget(key: string, content: unknown) {
				if (key === "pi-todo" && Array.isArray(content) && content.every((line) => typeof line === "string")) {
					widgetFrames.push([...content]);
				}
			},
			theme: {
				fg: (_slot: string, text: string) => text,
				bold: (text: string) => text,
			},
		} as unknown as ExtensionUIContext;

		try {
			await harness.session.bindExtensions({ uiContext, mode: "tui" });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write_todo", {
						items: [
							{
								id: "T1",
								title: "Implement auth",
								depends_on: [],
								acceptance_criteria: ["Auth is implemented"],
								size_hint: "small",
							},
							{
								id: "T2",
								title: "Implement API",
								depends_on: [],
								acceptance_criteria: ["API is implemented"],
								size_hint: "small",
							},
							{
								id: "T3",
								title: "Add integration tests",
								depends_on: ["T1", "T2"],
								acceptance_criteria: ["Integration tests pass"],
								size_hint: "big",
							},
						],
						global_direction: "Ship a tested authentication API",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("next_wave", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[
						fauxToolCall("Agent", {
							description: "pi-todo:T1",
							prompt: "Implement T1",
							run_in_background: true,
						}),
						fauxToolCall("Agent", {
							description: "pi-todo:T2",
							prompt: "Implement T2",
							run_in_background: true,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("mark", { id: "T1", status: "done" }), fauxToolCall("mark", { id: "T2", status: "done" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("next_wave", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					fauxToolCall("Agent", {
						description: "pi-todo:T3",
						prompt: "Implement T3",
						run_in_background: true,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("mark", { id: "T3", status: "done" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("next_wave", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("Todo complete."),
			]);

			await harness.session.prompt("/todo implement auth and API, then add integration tests");
			await harness.session.waitForIdle();

			const planMessage = harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === "pi-todo-plan",
			);
			expect(getMessageText(planMessage)).toContain("implement auth and API, then add integration tests");
			expect(getMessageText(planMessage)).toContain("calling write_todo");
			expect(dispatches).toEqual(expect.arrayContaining(["pi-todo:T1", "pi-todo:T2", "pi-todo:T3"]));
			expect(dispatches).toHaveLength(3);

			const waveResults = getToolResults(harness.session.messages, "next_wave");
			expect(waveResults).toHaveLength(3);
			expect(waveResults[0]?.details).toMatchObject({
				wave: 1,
				tasks: [{ id: "T1" }, { id: "T2" }],
				waiting: false,
			});
			expect(waveResults[1]?.details).toMatchObject({ wave: 2, tasks: [{ id: "T3" }], waiting: false });
			expect(waveResults[2]?.details).toMatchObject({ complete: true, tasks: [] });

			const markResults = getToolResults(harness.session.messages, "mark");
			expect(markResults).toHaveLength(3);
			expect(markResults.map((result) => result.details)).toEqual([
				expect.objectContaining({ item: expect.objectContaining({ id: "T1", status: "done" }) }),
				expect.objectContaining({ item: expect.objectContaining({ id: "T2", status: "done" }) }),
				expect.objectContaining({
					item: expect.objectContaining({ id: "T3", status: "done" }),
					summary: { total: 3, done: 3, pending: 0, failed: 0, blocked: 0 },
				}),
			]);
			expect(getToolResults(harness.session.messages, "write_todo")).toHaveLength(1);
			expect(getToolResults(harness.session.messages, "Agent")).toHaveLength(3);
			expect(harness.getPendingResponseCount()).toBe(0);

			const renderedWidgets = widgetFrames.map((lines) => lines.join("\n"));
			expect(renderedWidgets.some((frame) => frame.includes("0/3") && frame.includes("○  T1"))).toBe(true);
			expect(renderedWidgets.some((frame) => frame.includes("◐  T1"))).toBe(true);
			expect(renderedWidgets.some((frame) => frame.includes("◑  T1"))).toBe(true);
			expect(renderedWidgets.at(-1)).toContain("3/3");
			expect(renderedWidgets.at(-1)).toContain("●  T3");
		} finally {
			harness.cleanup();
		}
	});
});
