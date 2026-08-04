import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@handy_wote/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@handy_wote/pi-ai";
import type { FauxProviderRegistration } from "@handy_wote/pi-ai/compat";
import { registerFauxProvider } from "@handy_wote/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../../../coding-agent/test/suite/harness.ts";
import piTodo from "../src/index.ts";
import { TODO_BINDING_ENTRY } from "../src/runtime.ts";
import { FileTodoStore } from "../src/store.ts";
import type { TodoBindingEntry } from "../src/types.ts";

type TodoExtensionAPI = Parameters<typeof piTodo>[0];

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

function getCustomMessages(messages: readonly unknown[], customType: string): unknown[] {
	return messages.filter(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "custom" &&
			"customType" in message &&
			message.customType === customType,
	);
}

function getToolErrorText(result: ToolResultMessage<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("repro: deletion after full completion", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "pi-todo-repro-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("completes everything, deletes tasks, and does not re-inject digests", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI, { dataDir })],
		});
		try {
			await harness.session.bindExtensions({ mode: "tui" });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write_todo", {
						global_direction: "Ship the API",
						items: [
							{ id: "A", subject: "Implement auth", depends_on: [] },
							{ id: "B", subject: "Implement API", depends_on: ["A"] },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("todo_claim", { id: "A" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("todo_update", { id: "A", status: "completed" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("todo_claim", { id: "B" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("todo_update", { id: "B", status: "completed" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("All tasks complete."),
			]);

			await harness.session.prompt("implement the plan");
			await harness.session.waitForIdle();
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(getToolResults(harness.session.messages, "todo_update")).toHaveLength(2);

			// User says 继续 with everything complete: no digest should be injected.
			harness.setResponses([fauxAssistantMessage("Nothing to do, all complete.")]);
			await harness.session.prompt("继续");
			await harness.session.waitForIdle();
			expect(getCustomMessages(harness.session.messages, "pi-todo-continuation")).toHaveLength(0);

			// User asks to delete the finished tasks: delete should succeed.
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("todo_delete", { id: "B" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("todo_delete", { id: "A" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Deleted."),
			]);
			await harness.session.prompt("把已经完成的任务都删掉");
			await harness.session.waitForIdle();
			const deleteResults = getToolResults(harness.session.messages, "todo_delete");
			for (const result of deleteResults) {
				expect(getToolErrorText(result)).not.toContain("must be released");
				expect(getToolErrorText(result)).not.toContain("does not exist");
			}

			// After deleting everything, another 继续 must not re-activate the todo.
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("继续");
			await harness.session.waitForIdle();
			expect(getCustomMessages(harness.session.messages, "pi-todo-continuation")).toHaveLength(0);
			expect(getCustomMessages(harness.session.messages, "pi-todo-plan")).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	}, 15_000);

	it("deletes a claimed task after reload without credentials and stops reactivating the list", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI, { dataDir })],
		});
		let reloadedFaux: FauxProviderRegistration | undefined;
		try {
			const theme = {
				fg: (_slot: string, text: string) => text,
				bold: (text: string) => text,
			};
			await harness.session.bindExtensions({
				uiContext: { setWidget: () => {}, notify: () => {}, theme } as never,
				mode: "tui",
			});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write_todo", {
						global_direction: "Ship the API",
						items: [
							{ id: "A", subject: "Implement auth", depends_on: [] },
							{ id: "B", subject: "Implement API", depends_on: ["A"] },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("todo_claim", { id: "A" }), { stopReason: "toolUse" }),
				// Session dies without completing or releasing A.
				fauxAssistantMessage("Paused mid-work."),
			]);
			await harness.session.prompt("implement the plan");
			await harness.session.waitForIdle();
			expect(getToolResults(harness.session.messages, "todo_claim")).toHaveLength(1);

			// Restart the session (like reopening pi).
			await harness.session.reload({
				beforeSessionStart() {
					const model = harness.models[0];
					reloadedFaux = registerFauxProvider({
						api: model.api,
						provider: model.provider,
						models: [
							{
								id: model.id,
								name: model.name,
								reasoning: model.reasoning,
								input: [...model.input],
								cost: { ...model.cost },
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							},
						],
					});
				},
			});
			const binding = [...harness.sessionManager.getBranch()]
				.reverse()
				.find((entry) => entry.type === "custom" && entry.customType === TODO_BINDING_ENTRY);
			if (binding?.type !== "custom") throw new Error("Missing todo binding after reload");
			const bindingData = binding.data as TodoBindingEntry;
			if (!bindingData.list_id) throw new Error("Missing todo list id after reload");
			const store = new FileTodoStore(dataDir);
			expect((await store.read(bindingData.list_id)).tasks.find((task) => task.id === "A")?.status).toBe(
				"in_progress",
			);

			// Delete the stuck task and its dependent directly after reload.
			reloadedFaux?.setResponses([
				fauxAssistantMessage(fauxToolCall("todo_delete", { id: "A" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("todo_delete", { id: "B" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Deleted."),
			]);
			await harness.session.prompt("把卡住的任务和剩余任务都删掉");
			await harness.session.waitForIdle();
			const deleteResults = getToolResults(harness.session.messages, "todo_delete");
			expect(deleteResults).toHaveLength(2);
			for (const result of deleteResults) expect(getToolErrorText(result)).not.toContain("Error");
			expect((await store.read(bindingData.list_id)).tasks).toEqual([]);

			// With no tasks left, execution-intent prompts do not reactivate the todo.
			reloadedFaux?.setResponses([fauxAssistantMessage("Nothing left.")]);
			await harness.session.prompt("继续");
			await harness.session.waitForIdle();
			expect(getCustomMessages(harness.session.messages, "pi-todo-continuation")).toHaveLength(0);
		} finally {
			reloadedFaux?.unregister();
			harness.cleanup();
		}
	}, 15_000);
});
