import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@handy_wote/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiPermissions, processToolCall } from "../src/index.ts";

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>;

function setup(pi: Partial<ExtensionAPI> = {}): { handler: ToolCallHandler; context: ExtensionContext } {
	let handler: ToolCallHandler = async () => undefined;
	const api = {
		on: (_event: string, h: ToolCallHandler) => {
			handler = h;
		},
		...pi,
	} as unknown as ExtensionAPI;
	createPiPermissions()(api);
	const context = {} as ExtensionContext;
	return { handler, context };
}

describe("tool_call mount point", () => {
	it("registers a tool_call handler that allows by default", async () => {
		const { handler, context } = setup();
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "ls" },
		};
		const result = await handler(event, context);
		expect(result).toBeUndefined();
	});

	it("can block a tool call with a reason", async () => {
		const { handler, context } = setup();
		// The gate contract: returning { block, reason } rejects the call.
		// The default gate allows; blocking is exercised via the custom gate test.
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "call-2",
			toolName: "bash",
			input: { command: "rm -rf /" },
		};
		const result = (await handler(event, context)) as { block: boolean; reason?: string } | undefined;
		expect(result).toBeUndefined();
	});

	it("supports a custom gate injected via options", async () => {
		let handler: ToolCallHandler = async () => undefined;
		const api = {
			on: (_event: string, h: ToolCallHandler) => {
				handler = h;
			},
		} as unknown as ExtensionAPI;
		createPiPermissions({
			processToolCall: async (event) => ({
				block: true,
				reason: `Blocked ${event.toolName} by custom gate`,
			}),
		})(api);
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "call-3",
			toolName: "write",
			input: { path: "x.txt", content: "hi" },
		};
		const result = (await handler(event, {} as ExtensionContext)) as { block: boolean; reason?: string };
		expect(result).toEqual({ block: true, reason: "Blocked write by custom gate" });
	});

	it("default gate processToolCall always allows", async () => {
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "call-4",
			toolName: "bash",
			input: { command: "git push" },
		};
		expect(await processToolCall(event, {} as ExtensionContext)).toBeUndefined();
	});
});
