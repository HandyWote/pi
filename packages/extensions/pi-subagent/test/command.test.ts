import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@handy_wote/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentsCommand } from "../src/command.ts";
import type { AgentManager } from "../src/manager.ts";
import { type AgentRecord, emptyUsage } from "../src/types.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function projectRecord(root: string): AgentRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		agentId: "agent-project",
		parentSessionId: "parent",
		definition: {
			name: "project-worker",
			description: "Project worker",
			systemPrompt: "Persisted project prompt",
			source: "project",
			filePath: path.join(root, ".pi", "agents", "project-worker.md"),
			isolation: "none",
		},
		task: "initial",
		mode: "background",
		status: "completed",
		cwd: root,
		isolation: "none",
		metadata: {},
		createdAt: now,
		endedAt: now,
		updatedAt: now,
		childSessionId: "agent-project",
		childSessionDir: path.join(root, "sessions", "agent-project"),
		childSessionPath: path.join(root, "sessions", "agent-project", "session.jsonl"),
		transcriptPath: path.join(root, "transcripts", "agent-project.jsonl"),
		usage: emptyUsage(),
		toolCount: 0,
		lastOutput: "done",
		activities: [],
		notified: true,
		lifecycleEventId: "event-project",
	};
}

function setup(options: { trusted: boolean; hasUI: boolean; approved: boolean }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-command-"));
	tempRoots.push(root);
	const definitionPath = path.join(root, ".pi", "agents", "available.md");
	fs.mkdirSync(path.dirname(definitionPath), { recursive: true });
	fs.writeFileSync(definitionPath, "---\nname: available\ndescription: Safe description\n---\nSecret prompt\n");
	const record = projectRecord(root);
	const resume = vi.fn(async () => ({ record, completion: Promise.resolve(record), detachAbort: () => {} }));
	const manager = {
		get: (agentId: string) => (agentId === record.agentId ? record : undefined),
		list: () => [record],
		resume,
	} as unknown as AgentManager;
	let handler: CommandHandler | undefined;
	const pi = {
		registerCommand: (_name: string, command: { handler: CommandHandler }) => {
			handler = command.handler;
		},
	} as unknown as ExtensionAPI;
	registerAgentsCommand(pi, () => manager);
	if (!handler) throw new Error("agents command was not registered");
	const confirm = vi.fn(async () => options.approved);
	const input = vi.fn(async () => "continue");
	const notify = vi.fn();
	const context = {
		cwd: root,
		hasUI: options.hasUI,
		isProjectTrusted: () => options.trusted,
		ui: { select: vi.fn(async () => "Resume"), confirm, input, notify },
	} as unknown as ExtensionCommandContext;
	return { handler, context, record, resume, confirm, input, notify };
}

describe("/agents", () => {
	it.each([
		{ name: "no UI", trusted: true, hasUI: false, approved: true, error: "interactive confirmation" },
		{ name: "declined approval", trusted: true, hasUI: true, approved: false, error: "not approved" },
	])("blocks project resume with $name", async ({ trusted, hasUI, approved, error }) => {
		const setupResult = setup({ trusted, hasUI, approved });

		await expect(setupResult.handler(setupResult.record.agentId, setupResult.context)).rejects.toThrow(error);
		expect(setupResult.resume).not.toHaveBeenCalled();
		expect(setupResult.input).not.toHaveBeenCalled();
	});

	it("hides a persisted project agent after trust is revoked", async () => {
		const setupResult = setup({ trusted: false, hasUI: true, approved: true });

		await setupResult.handler(setupResult.record.agentId, setupResult.context);

		expect(setupResult.resume).not.toHaveBeenCalled();
		expect(setupResult.input).not.toHaveBeenCalled();
		expect(setupResult.notify).toHaveBeenCalledWith(
			`Unknown agent: ${setupResult.record.agentId}. Available agents: none`,
			"error",
		);
	});

	it("resumes a project agent only after approval", async () => {
		const setupResult = setup({ trusted: true, hasUI: true, approved: true });

		await setupResult.handler(setupResult.record.agentId, setupResult.context);

		expect(setupResult.confirm).toHaveBeenCalledOnce();
		expect(setupResult.input).toHaveBeenCalledOnce();
		expect(setupResult.resume).toHaveBeenCalledWith(setupResult.record.agentId, "continue", "background");
	});

	it("includes safely discovered names in unknown-agent errors", async () => {
		const setupResult = setup({ trusted: true, hasUI: true, approved: true });

		await setupResult.handler("missing-id", setupResult.context);

		expect(setupResult.notify).toHaveBeenCalledWith(
			"Unknown agent: missing-id. Available agents: available",
			"error",
		);
	});

	it("hides project definitions and history when project trust is revoked", async () => {
		const setupResult = setup({ trusted: false, hasUI: false, approved: true });

		await setupResult.handler("", setupResult.context);

		expect(setupResult.notify).toHaveBeenCalledWith("No agents", "info");
		const output = setupResult.notify.mock.calls.map((call) => String(call[0])).join("\n");
		expect(output).not.toContain("project-worker");
		expect(output).not.toContain("Safe description");
		expect(output).not.toContain("Secret prompt");
	});
});
