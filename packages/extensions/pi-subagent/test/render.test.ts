import * as path from "node:path";
import type { Theme } from "@handy_wote/pi-coding-agent";
import { visibleWidth } from "@handy_wote/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentManager } from "../src/manager.ts";
import { AgentPanel, renderAgentResult } from "../src/render.ts";
import { type AgentRecord, emptyUsage } from "../src/types.ts";

const theme = {
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

function record(): AgentRecord {
	const root = "/tmp/pi-subagent-render";
	const now = new Date().toISOString();
	return {
		version: 2,
		agentId: "agent-render-width-test",
		runId: "run-render-width-test",
		parentSessionId: "parent-render",
		definition: {
			name: "worker-with-an-extremely-long-display-name",
			description: "Render worker",
			systemPrompt: "Render safely.",
			source: "user",
			filePath: path.join(root, "worker.md"),
			isolation: "none",
		},
		task: "a very long task that must remain inside the current terminal width without overlapping later UI",
		mode: "foreground",
		status: "failed",
		cwd: root,
		isolation: "none",
		metadata: {},
		createdAt: now,
		startedAt: now,
		endedAt: now,
		updatedAt: now,
		childSessionId: "agent-render-width-test",
		childSessionDir: path.join(root, "sessions", "agent-render-width-test"),
		transcriptPath: path.join(root, "transcripts", "agent-render-width-test.jsonl"),
		usage: { ...emptyUsage(), input: 12345, output: 6789 },
		toolCount: 12,
		lastOutput: "long output",
		error: "an error message with a long dynamic path /some/repository/location/that/cannot/fit/on/a/narrow/terminal",
		activities: [
			{ type: "tool", text: "tool-with-a-long-name-and-arguments", timestamp: Date.now() },
			{
				type: "text",
				text: "activity output that is intentionally much wider than a narrow terminal",
				timestamp: Date.now(),
			},
		],
		notified: false,
		lifecycleEventId: "event-render-width-test",
	};
}

describe("renderAgentResult", () => {
	it.each([20, 120])("keeps every dynamic line within a %i-column viewport", (width) => {
		const component = renderAgentResult(
			{
				operation: "output",
				records: [record()],
				definitions: [
					{
						name: "worker",
						source: "user",
						description: "a discoverable definition description that is intentionally wider than the viewport",
					},
				],
				transcript: "transcript line that is also deliberately long",
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const lines = component.render(width);

		expect(lines.length).toBeGreaterThan(5);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});

describe("AgentPanel", () => {
	it("flattens multi-line tasks so each record renders as one line", () => {
		const multiLine = record();
		multiLine.status = "running";
		multiLine.lastOutput = "";
		multiLine.activities = [];
		multiLine.task = "Step one: read /a/b/c\n1. read /home/handy/projects/pi/README.md\n2. run a command";
		const manager = { list: () => [multiLine] } as unknown as AgentManager;
		const lines = new AgentPanel(manager, theme).render(120);

		expect(lines.length).toBe(2); // header + one record row
		expect(lines.some((line) => line.includes("Step one: read"))).toBe(true);
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("prefers live lastOutput over the launch task in the row text", () => {
		const live = record();
		live.status = "running";
		live.lastOutput = "Now patching the render pipeline";
		live.activities = [
			{ type: "tool", text: "read", timestamp: Date.now() },
			{ type: "text", text: "Now patching the render pipeline", timestamp: Date.now() },
		];
		const manager = { list: () => [live] } as unknown as AgentManager;
		const lines = new AgentPanel(manager, theme).render(120);

		expect(lines.some((line) => line.includes("Now patching the render pipeline"))).toBe(true);
		expect(lines.some((line) => line.includes("a very long task"))).toBe(false);
	});

	it("falls back to the latest tool activity when there is no assistant output yet", () => {
		const toolOnly = record();
		toolOnly.status = "running";
		toolOnly.lastOutput = "";
		toolOnly.activities = [{ type: "tool", text: "edit", timestamp: Date.now() }];
		toolOnly.task = "Original launch task";
		const manager = { list: () => [toolOnly] } as unknown as AgentManager;
		const lines = new AgentPanel(manager, theme).render(120);

		expect(lines.some((line) => line.includes("edit"))).toBe(true);
		expect(lines.some((line) => line.includes("Original launch task"))).toBe(false);
	});

	it("shows only active records and reports only the active count", () => {
		const running = record();
		running.status = "running";
		running.lastOutput = "Running worker output";
		const terminal = record();
		terminal.status = "completed";
		terminal.lastOutput = "Terminal worker output";
		terminal.definition = { ...terminal.definition, name: "terminal-worker" };
		const manager = { list: () => [terminal, running] } as unknown as AgentManager;
		const lines = new AgentPanel(manager, theme).render(120);

		expect(lines.some((line) => line.includes("Running worker output"))).toBe(true);
		expect(lines.some((line) => line.includes("Terminal worker output"))).toBe(false);
		expect(lines[0]!.includes("1 active")).toBe(true);
		expect(lines[0]!.includes("total")).toBe(false);
	});

	it("renders nothing when no active records remain", () => {
		const terminal = record();
		terminal.status = "completed";
		const manager = { list: () => [terminal] } as unknown as AgentManager;
		const lines = new AgentPanel(manager, theme).render(120);

		expect(lines).toEqual([]);
	});
});
