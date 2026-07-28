import type { AgentTool } from "@handy_wote/pi-agent-core";
import type { ToolResultMessage } from "@handy_wote/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@handy_wote/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../../../coding-agent/test/suite/harness.ts";
import piTodo from "../src/index.ts";

type TodoExtensionAPI = Parameters<typeof piTodo>[0];

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

function getTodoPlanMessages(messages: readonly unknown[]): unknown[] {
	return messages.filter(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "custom" &&
			"customType" in message &&
			message.customType === "pi-todo-plan",
	);
}

describe("pi-todo end-to-end", () => {
	it("runs /todo through the faux provider, Agent events, waves, reviews, and widget", async () => {
		let extensionApi: TodoExtensionAPI | undefined;
		const dispatches: string[] = [];
		const widgetFrames: string[][] = [];
		const widgetPlacements: Array<string | undefined> = [];

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
					extensionApi = pi as unknown as TodoExtensionAPI;
					piTodo(extensionApi);
				},
			],
		});
		const uiContext = {
			setWidget(key: string, content: unknown, options?: { placement?: string }) {
				if (key === "pi-todo" && Array.isArray(content) && content.every((line) => typeof line === "string")) {
					widgetFrames.push([...content]);
					widgetPlacements.push(options?.placement);
				}
			},
			theme: {
				fg: (_slot: string, text: string) => text,
				bold: (text: string) => text,
			},
		};

		try {
			type BindExtensionsOptions = Parameters<typeof harness.session.bindExtensions>[0];
			await harness.session.bindExtensions({
				uiContext: uiContext as BindExtensionsOptions["uiContext"],
				mode: "tui",
			});
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
			expect(widgetPlacements).not.toHaveLength(0);
			expect(widgetPlacements.every((placement) => placement === "aboveStatus")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("injects a todo plan message when the user confirms execution of a recent plan", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI)],
		});

		try {
			harness.setResponses([
				fauxAssistantMessage("Implementation plan:\n1. Update command handling\n2. Add verification"),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("先给方案");
			await harness.session.waitForIdle();
			expect(getTodoPlanMessages(harness.session.messages)).toHaveLength(0);

			await harness.session.prompt("go ahead");
			await harness.session.waitForIdle();

			const planMessage = getTodoPlanMessages(harness.session.messages)[0];
			expect(getMessageText(planMessage)).toContain("Source: recent context");
			expect(getMessageText(planMessage)).toContain("Current user execution request:\ngo ahead");
			expect(getMessageText(planMessage)).toContain("Implementation plan");
			expect(getMessageText(planMessage)).toContain("calling write_todo");
		} finally {
			harness.cleanup();
		}
	});

	it("injects a todo plan message when the current prompt contains a plan and execution intent", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI)],
		});

		try {
			harness.setResponses([fauxAssistantMessage("done")]);

			const prompt = [
				"Implementation plan:",
				"1. Update command handling",
				"2. Add verification",
				"",
				"Go ahead and implement the plan.",
			].join("\n");
			await harness.session.prompt(prompt);
			await harness.session.waitForIdle();

			const planMessages = getTodoPlanMessages(harness.session.messages);
			expect(planMessages).toHaveLength(1);
			const planText = getMessageText(planMessages[0]);
			expect(planText).toContain("Source: current prompt");
			expect(planText).toContain(`Current user execution request:\n${prompt}`);
			expect(planText).toContain("The current request contains the plan to execute.");
			expect(planText).toContain("Implementation plan");
			expect(planText).toContain("calling write_todo");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("does not auto-trigger for plan-only, investigate, or no-modification prompts", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI)],
		});

		try {
			harness.setResponses([
				fauxAssistantMessage("ack"),
				fauxAssistantMessage("ack"),
				fauxAssistantMessage("ack"),
				fauxAssistantMessage("ack"),
				fauxAssistantMessage("ack"),
			]);

			const prompts = [
				["Implementation plan:", "1. Update command handling", "2. Add verification"].join("\n"),
				"go ahead and review the plan",
				"proceed to investigate this",
				["Investigate this task plan:", "1. Review command handling", "2. Check verification gaps"].join("\n"),
				[
					"Implementation plan:",
					"1. Update command handling",
					"2. Add verification",
					"",
					"Go ahead, but without code changes.",
				].join("\n"),
			];

			for (const prompt of prompts) {
				await harness.session.prompt(prompt);
				await harness.session.waitForIdle();
				expect(getTodoPlanMessages(harness.session.messages)).toHaveLength(0);
			}
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
