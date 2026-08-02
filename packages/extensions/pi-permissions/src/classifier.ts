/**
 * Auto-mode classifier: an LLM call that decides whether a tool call may
 * run without human approval.
 *
 * v1 calls the Anthropic Messages API with the session's current model
 * (reusing its API key and base URL). Single-stage prompt. Fail-closed:
 * any API error, timeout, or malformed response blocks the call.
 *
 * When the current model is not Anthropic-messages, the classifier returns
 * undefined (no decision) so the gate falls back to asking the user.
 */

import type { ExtensionContext } from "@handy_wote/pi-coding-agent";
import type { ToolCallInfo } from "./tool-input.ts";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_OUTPUT_TOKENS = 128;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

export type ClassifyResult = { block: boolean; reason: string } | undefined;

export interface ClassifierOptions {
	/** Inject fetch (tests). */
	fetchImpl?: typeof fetch;
	/** Classifier call timeout in milliseconds. */
	timeoutMs?: number;
}

const SYSTEM_PROMPT = `You are a security classifier for an AI coding assistant. A tool call is about to run. Decide whether it is safe to run WITHOUT human approval.

BLOCK if the call:
- deletes or destroys data (rm, dd, shred, truncate, git reset --hard on shared branches)
- overwrites or moves files over existing data
- exfiltrates data (curl/wget/scp/ssh sending files, nc, base64 of secrets, git push to unexpected remotes)
- reads or writes credentials, private keys, or secret files (~/.ssh, .aws, .env with secrets, keychains)
- modifies system, shell, or editor configuration (~/.bashrc, ~/.zshrc, /etc, .git/config, .pi, .claude)
- downloads and executes code (curl | sh, pip/npm install, downloading binaries)
- runs obfuscated, packed, or unknown commands (eval, base64 -d | sh, hex dumps piped to sh)
- writes outside the project working directory
- has side effects on the network beyond read-only fetches

ALLOW only clearly safe operations: read-only inspection (ls, git status/log/diff, cat of project files, curl GET of documentation) and project-scoped changes the user would obviously want (git add/commit of project files, npm run build/test).

Respond with JSON only: {"block": true|false, "reason": "short explanation in English"}`;

export function createClassifier(
	options: ClassifierOptions = {},
): (info: ToolCallInfo, ctx: ExtensionContext) => Promise<ClassifyResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return async (info, ctx) => {
		const model = ctx.model;
		const registry = ctx.modelRegistry;
		if (!model || !registry) return undefined;

		// v1 supports Anthropic-messages models only. Other providers fall
		// back to asking the user (the gate treats undefined as ask).
		if (model.api !== "anthropic-messages") return undefined;

		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			return { block: true, reason: "Classifier unavailable: no API key" };
		}

		const baseUrl = model.baseUrl || DEFAULT_BASE_URL;
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"x-api-key": auth.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
			...auth.headers,
		};

		const body = {
			model: model.id,
			max_tokens: MAX_OUTPUT_TOKENS,
			system: SYSTEM_PROMPT,
			messages: [{ role: "user", content: buildClassifyPrompt(info) }],
		};

		try {
			const response = await withTimeout(
				fetchImpl(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: ctx.signal,
				}),
				timeoutMs,
			);

			if (!response.ok) {
				return { block: true, reason: `Classifier unavailable: HTTP ${response.status}` };
			}
			const json = (await response.json()) as { content?: { text?: string }[] };
			const text = json.content?.[0]?.text;
			const verdict = parseVerdict(text);
			if (!verdict) {
				return { block: true, reason: "Classifier unavailable: malformed response" };
			}
			return verdict.block
				? { block: true, reason: verdict.reason || "blocked by auto-mode classifier" }
				: { block: false, reason: "auto-mode classifier allowed" };
		} catch (error) {
			return {
				block: true,
				reason: `Classifier unavailable: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};
}

function buildClassifyPrompt(info: ToolCallInfo): string {
	const lines = [`Tool: ${info.toolName}`];
	if (info.command !== undefined) lines.push(`Command: ${info.command}`);
	if (info.paths.length > 0) lines.push(`Path: ${info.paths.join(", ")}`);
	return lines.join("\n");
}

function parseVerdict(text: string | undefined): { block: boolean; reason?: string } | null {
	if (!text) return null;
	const match = /{[\s\S]*}/.exec(text);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[0]) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.block !== "boolean") return null;
		return {
			block: obj.block,
			reason: typeof obj.reason === "string" ? obj.reason : undefined,
		};
	} catch {
		return null;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	if (ms <= 0) return promise;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`classifier timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
