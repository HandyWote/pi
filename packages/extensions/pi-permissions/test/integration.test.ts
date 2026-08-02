/**
 * End-to-end integration tests: the extension loaded into a real
 * AgentSession with the faux provider. Runs headless (no TUI), so asks
 * auto-deny — this exercises the fail-closed path with guidance.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@handy_wote/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	type Harness,
} from "../../../coding-agent/test/suite/harness.ts";
import { createPiPermissions } from "../src/index.ts";

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface SetupResult {
	harness: Harness;
	userRulesPath: string;
	denialsLogPath: string;
}

async function setup(userRules?: Record<string, string[]>): Promise<SetupResult> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-integration-"));
	tempRoots.push(root);
	const userRulesPath = path.join(root, "permissions.json");
	if (userRules) {
		fs.writeFileSync(userRulesPath, JSON.stringify(userRules));
	}
	const denialsLogPath = path.join(root, "denials.jsonl");
	const harness = await createHarness({
		extensionFactories: [
			// The factory type comes from the package's dist types while the
			// harness types come from the coding-agent source; bridge the two.
			{
				name: "pi-permissions",
				factory: createPiPermissions({ userRulesPath, denialsLogPath }) as never,
			},
		],
	});
	// The harness never binds a mode (that is the TUI/RPC layer's job), so
	// session_start is not emitted and the gate stays fail-closed. Bind with
	// a headless mode to start the extension session.
	await harness.session.bindExtensions({ mode: "rpc" });
	return { harness, userRulesPath, denialsLogPath };
}

/** Run a prompt whose model response is a tool call followed by final text. */
async function runToolCall(
	harness: Harness,
	toolName: string,
	args: Record<string, unknown>,
	options: { finalText?: string } = {},
): Promise<Harness> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" }),
		fauxAssistantMessage(options.finalText ?? "done"),
	]);
	await harness.session.prompt("run");
	return harness;
}

interface ToolResultInfo {
	text: string;
	isError?: boolean;
}

function toolResults(harness: Harness): ToolResultInfo[] {
	return harness.session.messages
		.filter((m) => m.role === "toolResult")
		.map((m) => ({ text: getMessageText(m), isError: m.isError }));
}

describe("pi-permissions integration (headless)", () => {
	it("auto-denies unapproved bash with guidance and records the denial", async () => {
		const { harness, denialsLogPath } = await setup();
		try {
			await runToolCall(harness, "bash", { command: "git push" });
			const results = toolResults(harness);
			expect(results.length).toBeGreaterThan(0);
			const first = results[0]!;
			expect(first.isError).toBe(true);
			expect(first.text).toContain("Permission denied");
			expect(first.text).toContain("--permissions-allow");

			// Audit log written.
			const log = fs.existsSync(denialsLogPath) ? fs.readFileSync(denialsLogPath, "utf-8") : "";
			expect(log).toContain("bash");
			expect(log).toContain("git push");
			expect(log).toContain("headless");
		} finally {
			harness.cleanup();
		}
	});

	it("allows read tools in chat mode", async () => {
		const { harness } = await setup();
		try {
			await runToolCall(harness, "read", { path: "missing.txt" });
			const results = toolResults(harness);
			const first = results[0] ?? { text: "" };
			expect(first.text).not.toContain("Permission denied");
			// The tool ran (and failed on a missing file — but not on permissions).
			expect(first.text).toContain("missing.txt");
		} finally {
			harness.cleanup();
		}
	});

	it("honors a user allow rule for bash", async () => {
		const { harness } = await setup({ allow: ["Bash(git:*)"] });
		try {
			await runToolCall(harness, "bash", { command: "git status" });
			const results = toolResults(harness);
			expect(results[0]?.text ?? "").not.toContain("Permission denied");
		} finally {
			harness.cleanup();
		}
	});

	it("honors a user deny rule for bash", async () => {
		const { harness, denialsLogPath } = await setup({ deny: ["Bash(git push)"] });
		try {
			await runToolCall(harness, "bash", { command: "git push" });
			const results = toolResults(harness);
			expect(results[0]?.text ?? "").toContain("denied by rule");
			const log = fs.existsSync(denialsLogPath) ? fs.readFileSync(denialsLogPath, "utf-8") : "";
			expect(log).toContain("rule");
		} finally {
			harness.cleanup();
		}
	});

	it("redlines writes into .git even with an allow rule", async () => {
		const { harness } = await setup({ allow: ["Write(.git/*)"] });
		try {
			await runToolCall(harness, "write", { path: ".git/config", content: "x" });
			const results = toolResults(harness);
			const first = results[0] ?? { text: "" };
			expect(first.text).toContain("Permission denied");
			expect(first.text).toContain("Sensitive path");
		} finally {
			harness.cleanup();
		}
	});

	it("completes a normal conversation with a final text response", async () => {
		const { harness } = await setup();
		try {
			harness.setResponses([fauxAssistantMessage("hello from model")]);
			await harness.session.prompt("hi");
			expect(getAssistantTexts(harness)).toContain("hello from model");
		} finally {
			harness.cleanup();
		}
	});
});
