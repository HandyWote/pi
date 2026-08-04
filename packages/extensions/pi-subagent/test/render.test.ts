import * as path from "node:path";
import type { Theme } from "@handy_wote/pi-coding-agent";
import { visibleWidth } from "@handy_wote/pi-tui";
import { describe, expect, it } from "vitest";
import { renderAgentResult } from "../src/render.ts";
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
