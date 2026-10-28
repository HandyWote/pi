import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../../../test/harness.ts";
import piTodo from "../src/index.ts";
import { TODO_BINDING_ENTRY } from "../src/runtime.ts";
import { FileTodoStore } from "../src/store.ts";
import type { TodoBindingEntry } from "../src/types.ts";

type TodoExtensionAPI = Parameters<typeof piTodo>[0];

function getToolResults(messages: readonly unknown[], toolName: string): ToolResultMessage[] {
	return messages.filter(
		(message): message is ToolResultMessage =>
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

describe("pi-todo standalone end-to-end", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "pi-todo-e2e-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("imports a plan and dynamically claims, completes, adds, deletes, lists, and inspects tasks", async () => {
		const widgetFrames: string[][] = [];
		const notifications: string[] = [];
		let reloadedFaux: FauxProviderRegistration | undefined;
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI, { dataDir })],
		});
		const theme = {
			fg: (_slot: string, text: string) => text,
			bold: (text: string) => text,
			strikethrough: (text: string) => text,
		};
		const uiContext = {
			setWidget(key: string, content: unknown) {
				if (key !== "pi-todo" || typeof content !== "function") return;
				const factory = content as (tui: TUI, widgetTheme: typeof theme) => Component;
				widgetFrames.push(factory({} as TUI, theme).render(72));
			},
			notify(message: string) {
				notifications.push(message);
			},
			theme,
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
						global_direction: "Ship the API",
						items: [
							{ id: "A", subject: "Implement auth", depends_on: [], acceptance_criteria: ["Auth works"] },
							{ id: "B", subject: "Implement API", depends_on: [], acceptance_criteria: ["API works"] },
							{ id: "C", subject: "Integrate", depends_on: ["A", "B"] },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("todo_list", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("todo_claim", { id: "A" }), fauxToolCall("todo_claim", { id: "B" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("todo_update", { id: "A", status: "completed" }),
						fauxToolCall("todo_update", { id: "B", status: "completed" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("todo_create", {
						items: [{ id: "D", subject: "Temporary check", depends_on: ["C"] }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("todo_delete", { id: "D" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("todo_get", { id: "C" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Paused with integration ready."),
			]);

			await harness.session.prompt("/todo implement auth and API, then integrate");
			await harness.session.waitForIdle();
			expect(getCustomMessages(harness.session.messages, "pi-todo-plan")).toHaveLength(1);
			expect(getToolResults(harness.session.messages, "write_todo")).toHaveLength(1);
			const claimResults = getToolResults(harness.session.messages, "todo_claim");
			expect(claimResults).toHaveLength(2);
			for (const claimResult of claimResults) {
				const text = getMessageText(claimResult);
				expect(text).toContain('"pi.todo/list-id"');
				expect(text).toContain('"pi.todo/task-id"');
				expect(text).not.toContain("claim-token");
				expect(text).toContain('"agent":"worker"');
			}
			expect(getToolResults(harness.session.messages, "todo_update")).toHaveLength(2);
			expect(getToolResults(harness.session.messages, "todo_create")).toHaveLength(1);
			expect(getToolResults(harness.session.messages, "todo_delete")).toHaveLength(1);
			expect(getMessageText(getToolResults(harness.session.messages, "todo_get")[0])).toContain("[pending] C");
			expect(harness.getPendingResponseCount()).toBe(0);

			await harness.session.prompt("/todo list");
			const listMessage = notifications.at(-1) ?? "";
			const plain = listMessage.replace(/\u001b\[\d+m/g, "");
			expect(plain).toContain("[x] A: Implement auth");
			expect(plain).toContain("[ ] C: Integrate");

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
					reloadedFaux.setResponses([fauxAssistantMessage("Continuing integration from the active todo state.")]);
				},
			});
			const binding = [...harness.sessionManager.getBranch()]
				.reverse()
				.find((entry) => entry.type === "custom" && entry.customType === TODO_BINDING_ENTRY);
			if (binding?.type !== "custom") throw new Error("Missing todo binding after reload");
			const bindingData = binding.data as TodoBindingEntry;
			if (!bindingData.list_id) throw new Error("Missing todo list id after reload");
			const restored = await new FileTodoStore(dataDir).read(bindingData.list_id);
			expect(restored.tasks.find((task) => task.id === "C")?.status).toBe("pending");

			await harness.session.prompt("继续");
			await harness.session.waitForIdle();
			// Keyword prompts no longer trigger continuation injection; only the
			// periodic turn-end digest (pi-todo-digest) may appear.
			expect(getCustomMessages(harness.session.messages, "pi-todo-continuation")).toHaveLength(0);
			expect(widgetFrames.some((frame) => frame.join("\n").includes("[ ] C Integrate"))).toBe(true);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			reloadedFaux?.unregister();
			harness.cleanup();
		}
	}, 15_000);

	it("never creates a todo from execution-intent keywords", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => piTodo(pi as unknown as TodoExtensionAPI, { dataDir })],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("Implementation plan:\n1. Update command handling\n2. Add verification"),
				fauxAssistantMessage("ack"),
			]);
			await harness.session.prompt("先给方案");
			await harness.session.waitForIdle();
			expect(getCustomMessages(harness.session.messages, "pi-todo-plan")).toHaveLength(0);
			await harness.session.prompt("go ahead");
			await harness.session.waitForIdle();
			await harness.session.prompt("继续");
			await harness.session.waitForIdle();
			expect(getCustomMessages(harness.session.messages, "pi-todo-plan")).toHaveLength(0);
			expect(getCustomMessages(harness.session.messages, "pi-todo-continuation")).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});
});
