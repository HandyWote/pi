import type { ExtensionAPI, ToolDefinition } from "@handy_wote/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerAgentTools } from "../src/tools.ts";

describe("agent tools", () => {
	it("exposes concrete delegation guidance in the system prompt", () => {
		const definitions: ToolDefinition[] = [];
		const pi = {
			registerTool: (definition: ToolDefinition) => definitions.push(definition),
		} as unknown as ExtensionAPI;

		registerAgentTools(pi, () => undefined);

		const start = definitions.find((definition) => definition.name === "agent_start");
		expect(start?.promptSnippet).toContain("Delegate independent");
		expect(start?.promptGuidelines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("one agent_start batch"),
				expect.stringContaining("built-in worker"),
				expect.stringContaining("process completion does not imply Todo completion"),
			]),
		);
	});
});
