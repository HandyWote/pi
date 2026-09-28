import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText);
}

export async function createHarness(options: { extensionFactories?: InlineExtension[]; tools?: AgentTool[] } = {}) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-extension-test-"));
	const agentDir = join(tempDir, "agent-home");
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory(tempDir);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: faux.api,
		streamSimple,
		apiKey: "faux-key",
		models: faux.models.map((m) => ({ ...m })),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		extensionFactories: options.extensionFactories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a test assistant.",
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		customTools: options.tools,
	});
	return {
		session,
		settingsManager,
		sessionManager,
		tempDir,
		models: faux.models,
		setResponses: faux.setResponses,
		appendResponses: faux.appendResponses,
		getPendingResponseCount: faux.getPendingResponseCount,
		cleanup() {
			session.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
