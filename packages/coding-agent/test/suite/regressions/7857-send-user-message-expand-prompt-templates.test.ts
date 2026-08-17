import { fauxAssistantMessage } from "@handy_wote/pi-ai";
import type { ExtensionAPI } from "@handy_wote/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("issue #7857 sendUserMessage expandPromptTemplates opt-in", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("sendUserMessage can opt into prompt template expansion", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("extension sendUserMessage can opt into extension command dispatch", async () => {
		let extensionApi: ExtensionAPI | undefined;
		let resolveCommandRun: (args: string) => void = () => {};
		const commandRun = new Promise<string>((resolve) => {
			resolveCommandRun = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							resolveCommandRun(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		expect(extensionApi).toBeDefined();

		extensionApi?.sendUserMessage("/testcmd hello world", { expandPromptTemplates: true });

		await expect(commandRun).resolves.toBe("hello world");
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
