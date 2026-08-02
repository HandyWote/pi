import * as os from "node:os";
import type { ExtensionContext, ToolCallEvent } from "@handy_wote/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { BashParseResult } from "../src/bash-analysis/index.ts";
import { parseBashCommand } from "../src/bash-analysis/index.ts";
import { Gate } from "../src/gate.ts";
import { emptyRuleCollection } from "../src/rules/index.ts";
import type { PermissionMode } from "../src/state.ts";
import { extractToolCallInfo, type ToolCallInfo } from "../src/tool-input.ts";

const CWD = "/home/user/project";

function bashInfo(command: string): ToolCallInfo {
	return extractToolCallInfo({
		type: "tool_call",
		toolCallId: "c1",
		toolName: "bash",
		input: { command },
	} as ToolCallEvent);
}

function writeInfo(pathValue: string): ToolCallInfo {
	return extractToolCallInfo({
		type: "tool_call",
		toolCallId: "c2",
		toolName: "write",
		input: { path: pathValue, content: "x" },
	} as ToolCallEvent);
}

function readInfo(pathValue: string): ToolCallInfo {
	return extractToolCallInfo({
		type: "tool_call",
		toolCallId: "c3",
		toolName: "read",
		input: { path: pathValue },
	} as ToolCallEvent);
}

async function decide(
	info: ToolCallInfo,
	options: {
		mode?: PermissionMode;
		rules?: ReturnType<typeof emptyRuleCollection>;
		parse?: (cmd: string) => Promise<BashParseResult>;
	} = {},
) {
	const gate = new Gate({ parseBashCommand: options.parse ?? parseBashCommand });
	const ctx = {} as ExtensionContext;
	return gate.decide(
		{
			info,
			rules: options.rules ?? emptyRuleCollection(),
			mode: options.mode ?? "chat",
			cwd: CWD,
		},
		ctx,
	);
}

describe("Gate: redline", () => {
	it("asks for writes inside .git even with an allow rule", async () => {
		const rules = emptyRuleCollection();
		rules.user.allow.push({ toolName: "write" });
		const d = await decide(writeInfo(".git/config"), { rules });
		expect(d.behavior).toBe("ask");
		expect(d.reason.type).toBe("redline");
	});

	it("asks for reads from ~/.ssh (read is redlined there)", async () => {
		const d = await decide(readInfo("~/.ssh/id_rsa"));
		expect(d.behavior).toBe("ask");
		expect(d.reason.type).toBe("redline");
	});

	it("does not redline ordinary files", async () => {
		const d = await decide(writeInfo("src/foo.ts"));
		// No redline, no rules: chat mode asks for writes.
		expect(d.behavior).toBe("ask");
	});
});

describe("Gate: rules", () => {
	it("denies a tool denied by rule", async () => {
		const rules = emptyRuleCollection();
		rules.user.deny.push({ toolName: "write" });
		const d = await decide(writeInfo("src/foo.ts"), { rules });
		expect(d.behavior).toBe("deny");
	});

	it("asks when a whole-tool ask rule exists", async () => {
		const rules = emptyRuleCollection();
		rules.user.ask.push({ toolName: "bash" });
		const d = await decide(bashInfo("ls"), { rules });
		expect(d.behavior).toBe("ask");
		expect(d.reason.type).toBe("rule");
	});

	it("allows a tool with an allow rule", async () => {
		const rules = emptyRuleCollection();
		rules.user.allow.push({ toolName: "bash", ruleContent: "git:*" });
		const d = await decide(bashInfo("git status"), { rules });
		expect(d.behavior).toBe("allow");
	});

	it("denies a bash subcommand matched by a deny rule", async () => {
		const rules = emptyRuleCollection();
		rules.user.deny.push({ toolName: "bash", ruleContent: "rm -rf *" });
		const d = await decide(bashInfo("git add a && rm -rf dist"), { rules });
		expect(d.behavior).toBe("deny");
	});

	it("asks when a subcommand needs approval and lists it", async () => {
		const rules = emptyRuleCollection();
		rules.user.ask.push({ toolName: "bash", ruleContent: "npm publish:*" });
		const d = await decide(bashInfo("npm run build && npm publish"), { rules });
		expect(d).toMatchObject({ behavior: "ask", ask: { details: ["npm publish"] } });
	});

	it("allows when every subcommand is allowed by rules", async () => {
		const rules = emptyRuleCollection();
		rules.user.allow.push({ toolName: "bash", ruleContent: "git:*" });
		rules.user.allow.push({ toolName: "bash", ruleContent: "npm run build" });
		const d = await decide(bashInfo("git status && npm run build"), { rules });
		expect(d.behavior).toBe("allow");
	});
});

describe("Gate: parser fallbacks", () => {
	it("asks when the parser is unavailable", async () => {
		const d = await decide(bashInfo("git status"), {
			parse: async () => ({ kind: "parse-unavailable", reason: "wasm not loaded" }),
		});
		expect(d.behavior).toBe("ask");
		expect(d.reason.type).toBe("parser");
	});

	it("still honors deny rules when the parser is unavailable", async () => {
		const rules = emptyRuleCollection();
		rules.user.deny.push({ toolName: "bash", ruleContent: "rm -rf *" });
		const d = await decide(bashInfo("rm -rf /"), {
			rules,
			parse: async () => ({ kind: "parse-unavailable", reason: "wasm not loaded" }),
		});
		expect(d.behavior).toBe("deny");
	});

	it("asks for too-complex commands", async () => {
		const d = await decide(bashInfo("echo $(rm -rf /)"), {
			parse: async () => ({ kind: "too-complex", reason: "command substitution" }),
		});
		expect(d.behavior).toBe("ask");
		expect(d.reason.type).toBe("parser");
	});
});

describe("Gate: modes", () => {
	it("chat mode asks for bash", async () => {
		const d = await decide(bashInfo("curl https://example.com"));
		expect(d.behavior).toBe("ask");
	});

	it("chat mode auto-allows read tools", async () => {
		const ls = extractToolCallInfo({
			type: "tool_call",
			toolCallId: "c4",
			toolName: "ls",
			input: {},
		} as ToolCallEvent);
		const d = await decide(ls);
		expect(d.behavior).toBe("allow");
	});

	it("chat mode asks for write", async () => {
		const d = await decide(writeInfo("src/foo.ts"));
		expect(d.behavior).toBe("ask");
	});

	it("acceptEdits mode allows edit/write but not bash", async () => {
		const dWrite = await decide(writeInfo("src/foo.ts"), { mode: "acceptEdits" });
		expect(dWrite.behavior).toBe("allow");

		const dEdit = await decide(
			extractToolCallInfo({
				type: "tool_call",
				toolCallId: "c5",
				toolName: "edit",
				input: { path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] },
			} as ToolCallEvent),
			{ mode: "acceptEdits" },
		);
		expect(dEdit.behavior).toBe("allow");

		const dBash = await decide(bashInfo("git push"), { mode: "acceptEdits" });
		expect(dBash.behavior).toBe("ask");
	});

	it("acceptEdits does not bypass the redline", async () => {
		const d = await decide(writeInfo(".git/config"), { mode: "acceptEdits" });
		expect(d.behavior).toBe("ask");
		expect(d.reason.type).toBe("redline");
	});

	it("chat mode read of home shell config is not redlined, writes are", async () => {
		const dRead = await decide(readInfo(`${os.homedir()}/.bashrc`));
		expect(dRead.behavior).toBe("allow");

		const dWrite = await decide(writeInfo(`${os.homedir()}/.bashrc`));
		expect(dWrite.behavior).toBe("ask");
		expect(dWrite.reason.type).toBe("redline");
	});
});
