import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@handy_wote/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@handy_wote/pi-ai";
import { getModel, streamSimple } from "@handy_wote/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type CompactionContinuationMessage,
	convertToLlm,
	THRESHOLD_AUTO_COMPACTION_CONTINUATION_TEXT,
} from "../src/core/messages.ts";
import { type CompactionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

type AutoCompactionOptionsForTest = { continueAfterThreshold?: boolean };

type SessionCompactionInternals = {
	_runAutoCompaction: (
		reason: "overflow" | "threshold",
		willRetry: boolean,
		options?: AutoCompactionOptionsForTest,
	) => Promise<boolean>;
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
};

describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("should continue the current run after post-run threshold compaction by default", async () => {
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const model = session.model!;
		const thresholdTokens =
			(model.contextWindow ?? 200_000) - settingsManager.getCompactionSettings().reserveTokens + 1;
		let callCount = 0;
		const compactionEnds: Array<{ reason: "manual" | "threshold" | "overflow"; willRetry: boolean }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				compactionEnds.push({ reason: event.reason, willRetry: event.willRetry });
			}
		});

		session.agent.streamFunction = (streamModel) => {
			callCount++;
			const stream = createAssistantMessageEventStream();
			const text =
				callCount === 1
					? "first response before compact"
					: callCount === 2
						? "compacted summary"
						: "continued work";
			const usageTokens = callCount === 2 ? 10 : thresholdTokens;
			void Promise.resolve().then(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(text),
						api: streamModel.api,
						provider: streamModel.provider,
						model: streamModel.id,
						usage: {
							input: usageTokens,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: usageTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
			});
			return stream;
		};

		const continueSpy = vi.spyOn(session.agent, "continue");

		const runAgentPrompt = (session as unknown as SessionCompactionInternals)._runAgentPrompt.bind(session);

		await expect(
			runAgentPrompt({
				role: "user",
				content: [{ type: "text", text: "start long task" }],
				timestamp: Date.now(),
			}),
		).resolves.toBeUndefined();

		expect(callCount).toBe(3);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(compactionEnds).toEqual([{ reason: "threshold", willRetry: false }]);
		expect(
			sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && !entry.display),
		).toHaveLength(0);

		const compactionEntries = sessionManager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.continuation).toEqual({ reason: "threshold_auto_compaction" });

		const continuationMessage = session.agent.state.messages.find(
			(message): message is CompactionContinuationMessage => message.role === "compactionContinuation",
		);
		expect(continuationMessage?.continuation).toEqual({ reason: "threshold_auto_compaction" });
		if (!continuationMessage) {
			throw new Error("missing compaction continuation");
		}
		const [llmSummary] = convertToLlm([continuationMessage]);
		const llmContent = llmSummary?.content;
		const llmText = Array.isArray(llmContent) && llmContent[0]?.type === "text" ? llmContent[0].text : "";
		expect(llmText).toContain(THRESHOLD_AUTO_COMPACTION_CONTINUATION_TEXT);
	});

	it("should allow another threshold compaction before a later queued turn", async () => {
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const model = session.model!;
		const thresholdTokens =
			(model.contextWindow ?? 200_000) - settingsManager.getCompactionSettings().reserveTokens + 1;
		let callCount = 0;
		let queuedFollowUp = false;
		const compactionEnds: Array<{ reason: "manual" | "threshold" | "overflow"; willRetry: boolean }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				compactionEnds.push({ reason: event.reason, willRetry: event.willRetry });
			}
		});

		session.agent.streamFunction = (streamModel) => {
			callCount++;
			const currentCall = callCount;
			const stream = createAssistantMessageEventStream();
			const usageTokens = currentCall === 1 || currentCall === 3 ? thresholdTokens : 10;
			void Promise.resolve().then(() => {
				if (currentCall === 3 && !queuedFollowUp) {
					queuedFollowUp = true;
					session.agent.followUp({
						role: "user",
						content: [{ type: "text", text: "queued follow-up" }],
						timestamp: Date.now(),
					});
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(`response ${currentCall}`),
						api: streamModel.api,
						provider: streamModel.provider,
						model: streamModel.id,
						usage: {
							input: usageTokens,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: usageTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
			});
			return stream;
		};

		const continueSpy = vi.spyOn(session.agent, "continue");
		const runAgentPrompt = (session as unknown as SessionCompactionInternals)._runAgentPrompt.bind(session);

		await runAgentPrompt({
			role: "user",
			content: [{ type: "text", text: "start long task" }],
			timestamp: Date.now(),
		});

		expect(callCount).toBe(5);
		expect(continueSpy).toHaveBeenCalledTimes(2);
		expect(compactionEnds).toEqual([
			{ reason: "threshold", willRetry: false },
			{ reason: "threshold", willRetry: false },
		]);
		expect(
			sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && !entry.display),
		).toHaveLength(0);
		const compactionEntries = sessionManager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(2);
		expect(compactionEntries[0]?.continuation).toEqual({ reason: "threshold_auto_compaction" });
		expect(compactionEntries[1]?.continuation).toBeUndefined();
	});

	it("should resume after threshold compaction when only agent-level queued messages exist", async () => {
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const model = session.model!;
		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "assistant response to compact" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now - 500,
		});
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		session.agent.streamFunction = (summaryModel) => {
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("compacted"),
						api: summaryModel.api,
						provider: summaryModel.provider,
						model: summaryModel.id,
						usage: {
							input: 10,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 10,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
			});
			return stream;
		};

		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const runAutoCompaction = (session as unknown as SessionCompactionInternals)._runAutoCompaction.bind(session);

		await expect(runAutoCompaction("threshold", false, { continueAfterThreshold: true })).resolves.toBe(true);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(
			sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && !entry.display),
		).toHaveLength(0);
		const compactionEntries = sessionManager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactionEntries[0]?.continuation).toBeUndefined();
	});

	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		const model = session.model!;
		const overflowMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		};

		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as SessionCompactionInternals, "_runAutoCompaction")
			.mockResolvedValue(true);

		const events: Array<{ type: string; reason: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason, errorMessage: event.errorMessage });
			}
		});

		const checkCompaction = (session as unknown as SessionCompactionInternals)._checkCompaction.bind(session);

		await checkCompaction(overflowMessage);
		await checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("should ignore stale pre-compaction assistant usage on pre-prompt compaction checks", async () => {
		const model = session.model!;
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 600_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 610_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: staleAssistantTimestamp,
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		sessionManager.appendMessage(staleAssistant);

		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, staleAssistant.usage.totalTokens, undefined, false);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session recovery payload" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as SessionCompactionInternals, "_runAutoCompaction")
			.mockResolvedValue(true);

		const checkCompaction = (session as unknown as SessionCompactionInternals)._checkCompaction.bind(session);

		await checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should trigger threshold compaction for error messages using last successful usage", async () => {
		const model = session.model!;

		// A successful assistant message with token usage just over the compaction threshold.
		// Compute this from the selected model so generated catalog context-window changes do not break the test.
		const compactionSettings = settingsManager.getCompactionSettings();
		const thresholdTokens = (model.contextWindow ?? 200_000) - compactionSettings.reserveTokens + 1;
		const successfulAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large successful response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: thresholdTokens - 10_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: thresholdTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// An error message (e.g. 529 overloaded) with no useful usage data
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		};

		// Put both messages into agent state so estimateContextTokens can find the successful one
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "another prompt" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as SessionCompactionInternals, "_runAutoCompaction")
			.mockResolvedValue(true);

		const checkCompaction = (session as unknown as SessionCompactionInternals)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, { continueAfterThreshold: false });
	});

	it("should not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const model = session.model!;

		// An error message with no prior successful assistant in context
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as SessionCompactionInternals, "_runAutoCompaction")
			.mockResolvedValue(true);

		const checkCompaction = (session as unknown as SessionCompactionInternals)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should not trigger threshold compaction for error messages when only kept pre-compaction usage exists", async () => {
		const model = session.model!;
		const preCompactionTimestamp = Date.now() - 10_000;

		// A "kept" assistant message from before compaction with high usage
		const keptAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "kept response from before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: preCompactionTimestamp,
		};

		// Record the kept assistant in the session and create a compaction after it
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined, false);

		// Post-compaction error message
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		// Agent state has the kept assistant (pre-compaction) and the error (post-compaction)
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user msg" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as SessionCompactionInternals, "_runAutoCompaction")
			.mockResolvedValue(true);

		const checkCompaction = (session as unknown as SessionCompactionInternals)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		// Should NOT compact because the only usage data is from a kept pre-compaction message
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
});
