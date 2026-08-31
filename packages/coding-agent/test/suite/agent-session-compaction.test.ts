import type { AgentTool } from "@handy_wote/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@handy_wote/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession between-turn compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts after a tool result before the next assistant request in the same run", async () => {
		const toolResult = `large-tool-result:${"x".repeat(6800)}`;
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
		};
		const order: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						order.push("compaction");
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				order.push("provider");
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const agentStartsBefore = harness.eventsOfType("agent_start").length;
		await harness.session.prompt("run the large tool");

		expect(order).toEqual(["compaction", "provider"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore + 1);
		expect(harness.eventsOfType("compaction_start").at(-1)).toEqual({
			type: "compaction_start",
			reason: "threshold",
		});
		expect(resumedRequest).toContain("compacted history");
		expect(resumedRequest).toContain("large-tool-result");
		expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
	});

	it("includes steering queued during compaction in the resumed assistant request", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
			fauxAssistantMessage("finished after delayed steering"),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("does not compact after a terminating tool result", async () => {
		const terminatingTool: AgentTool = {
			name: "terminate_with_large_result",
			label: "Terminate with large result",
			description: "Returns enough content to cross the compaction threshold, then terminates",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [terminatingTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "unexpected compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("terminate_with_large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
