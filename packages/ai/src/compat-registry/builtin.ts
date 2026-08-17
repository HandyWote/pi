import type { ModelCompatRegistry } from "./types.ts";
import { compileCompatRegistry } from "./validation.ts";

const GPT_GROUP = { id: "gpt", label: "GPT" } as const;
const CLAUDE_GROUP = { id: "claude", label: "Claude" } as const;
const GEMINI_GROUP = { id: "gemini", label: "Gemini" } as const;

const OPENAI_PREFERRED_APIS = ["openai-responses", "openai-completions"] as const;
const CLAUDE_PREFERRED_APIS = ["anthropic-messages", "openai-completions"] as const;
const GOOGLE_PREFERRED_APIS = ["google-generative-ai", "google-vertex"] as const;

const builtinCompatRegistryData: ModelCompatRegistry = {
	version: 1,
	families: [
		// cd00a0d9^: generate-models.ts DEEPSEEK_V4_THINKING_LEVEL_MAP, deepseekCompat, deepseekV4Models.
		{
			id: "deepseek-v4",
			match: { ids: ["deepseek-v4"], prefixes: ["deepseek-v4-"] },
			metadata: { reasoning: true, vision: false, toolCall: true, contextWindow: 1_000_000, maxTokens: 384_000 },
			group: { id: "deepseek", label: "DeepSeek" },
			preferredApis: ["openai-completions"],
			apis: {
				"openai-completions": {
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						thinkingFormat: "deepseek",
						maxTokensField: "max_tokens",
						requiresReasoningContentOnAssistantMessages: true,
						requiresToolSchemaRequiredArray: true,
					},
					thinkingLevelMap: {
						minimal: null,
						low: null,
						medium: null,
						high: "high",
						max: "max",
					},
				},
			},
		},
		// cd00a0d9^: generate-models.ts ZAI_GLM52_THINKING_LEVEL_MAP and the official z.ai catalog path.
		{
			id: "glm",
			match: { ids: ["glm"], prefixes: ["glm-"] },
			group: { id: "glm", label: "GLM" },
			preferredApis: ["openai-completions"],
		},
		// cd00a0d9^: generate-models.ts moonshotCompat; applies to the official Moonshot OpenAI-compatible API.
		{
			id: "kimi",
			match: { ids: ["kimi"], prefixes: ["kimi-"] },
			group: { id: "kimi", label: "Kimi" },
			preferredApis: ["openai-completions"],
			apis: {
				"openai-completions": {
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						maxTokensField: "max_tokens",
						supportsStrictMode: false,
						thinkingFormat: "deepseek",
					},
				},
			},
		},
		// cd00a0d9^: supportsOpenAiXhigh(), Responses off handling, and Codex minimal-to-low mapping.
		{
			id: "gpt-5.2",
			match: { ids: ["gpt-5.2"], prefixes: ["gpt-5.2-"] },
			group: GPT_GROUP,
			preferredApis: [...OPENAI_PREFERRED_APIS],
			apis: {
				"openai-completions": { thinkingLevelMap: { xhigh: "xhigh" } },
				"openai-responses": { thinkingLevelMap: { off: null, xhigh: "xhigh" } },
				"openai-codex-responses": { thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } },
			},
		},
		{
			id: "gpt-5.3",
			match: { prefixes: ["gpt-5.3-"] },
			group: GPT_GROUP,
			preferredApis: [...OPENAI_PREFERRED_APIS],
			apis: {
				"openai-completions": { thinkingLevelMap: { xhigh: "xhigh" } },
				"openai-responses": { thinkingLevelMap: { off: null, xhigh: "xhigh" } },
				"openai-codex-responses": { thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } },
			},
		},
		{
			id: "gpt-5.4",
			match: { ids: ["gpt-5.4"], prefixes: ["gpt-5.4-"] },
			group: GPT_GROUP,
			preferredApis: [...OPENAI_PREFERRED_APIS],
			apis: {
				"openai-completions": { thinkingLevelMap: { xhigh: "xhigh" } },
				"openai-responses": { thinkingLevelMap: { off: null, xhigh: "xhigh" } },
				"openai-codex-responses": { thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } },
			},
		},
		{
			id: "gpt-5.5",
			match: { ids: ["gpt-5.5"], prefixes: ["gpt-5.5-"] },
			group: GPT_GROUP,
			preferredApis: [...OPENAI_PREFERRED_APIS],
			apis: {
				"openai-completions": { thinkingLevelMap: { xhigh: "xhigh" } },
				"openai-responses": { thinkingLevelMap: { off: null, xhigh: "xhigh" } },
				"openai-codex-responses": { thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } },
			},
		},
		{
			id: "gpt-5.6",
			match: { prefixes: ["gpt-5.6-"] },
			group: GPT_GROUP,
			preferredApis: [...OPENAI_PREFERRED_APIS],
			apis: {
				"openai-completions": { thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
				"openai-responses": { thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
				"openai-codex-responses": {
					thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
				},
			},
		},
		// cd00a0d9^: Anthropic adaptive-thinking docs encoded by applyThinkingLevelMetadata().
		{
			id: "claude-fable-5",
			match: { ids: ["claude-fable-5"], prefixes: ["claude-fable-5-"] },
			metadata: { reasoning: true },
			group: CLAUDE_GROUP,
			preferredApis: [...CLAUDE_PREFERRED_APIS],
			apis: {
				"anthropic-messages": {
					compat: { forceAdaptiveThinking: true, supportsToolReferences: true },
					thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
				},
			},
		},
		// 60f6a8034: claude-opus-5 is an adaptive-thinking model with no temperature
		// support, same anthropic-messages compat as Opus 4.7/4.8.
		{
			id: "claude-opus-4.7-4.8",
			match: {
				ids: [
					"claude-opus-4-7",
					"claude-opus-4-8",
					"claude-opus-4.7",
					"claude-opus-4.8",
					"claude-opus-5",
					"claude-opus.5",
				],
				prefixes: ["claude-opus-4-7-", "claude-opus-4-8-", "claude-opus-5-"],
			},
			metadata: { reasoning: true },
			group: CLAUDE_GROUP,
			preferredApis: [...CLAUDE_PREFERRED_APIS],
			apis: {
				"anthropic-messages": {
					compat: {
						forceAdaptiveThinking: true,
						supportsTemperature: false,
						supportsToolReferences: true,
					},
					thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				},
			},
		},
		{
			id: "claude-sonnet-5",
			match: { ids: ["claude-sonnet-5", "claude-sonnet.5"], prefixes: ["claude-sonnet-5-"] },
			metadata: { reasoning: true },
			group: CLAUDE_GROUP,
			preferredApis: [...CLAUDE_PREFERRED_APIS],
			apis: {
				"anthropic-messages": {
					compat: { forceAdaptiveThinking: true, supportsToolReferences: true },
					thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				},
			},
		},
		{
			id: "claude-opus-sonnet-4.6",
			match: {
				ids: ["claude-opus-4-6", "claude-opus-4.6", "claude-sonnet-4-6", "claude-sonnet-4.6"],
				prefixes: ["claude-opus-4-6-", "claude-sonnet-4-6-"],
			},
			metadata: { reasoning: true, contextWindow: 1_000_000 },
			group: CLAUDE_GROUP,
			preferredApis: [...CLAUDE_PREFERRED_APIS],
			apis: {
				"anthropic-messages": {
					compat: { forceAdaptiveThinking: true, supportsToolReferences: true },
					thinkingLevelMap: { max: "max" },
				},
			},
		},
		// cd00a0d9^: anthropic-messages.ts defaultSupportsToolReferences() for Claude 4.5.
		{
			id: "claude-4.5-tool-references",
			match: {
				ids: ["claude-opus-4-5", "claude-sonnet-4-5"],
				prefixes: ["claude-opus-4-5-", "claude-sonnet-4-5-"],
			},
			group: CLAUDE_GROUP,
			preferredApis: [...CLAUDE_PREFERRED_APIS],
			apis: { "anthropic-messages": { compat: { supportsToolReferences: true } } },
		},
		{
			id: "claude",
			match: { ids: ["claude"], prefixes: ["claude-"] },
			group: CLAUDE_GROUP,
			preferredApis: [...CLAUDE_PREFERRED_APIS],
		},
		// cd00a0d9^: Gemini 3/Gemma 4 maps in applyThinkingLevelMetadata().
		{
			id: "gemini-3-pro",
			match: {
				ids: ["gemini-3-pro", "gemini-3.1-pro"],
				prefixes: ["gemini-3-pro-", "gemini-3.1-pro-"],
			},
			metadata: { reasoning: true },
			group: GEMINI_GROUP,
			preferredApis: [...GOOGLE_PREFERRED_APIS],
			apis: {
				"google-generative-ai": {
					thinkingLevelMap: { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" },
				},
				"google-vertex": {
					thinkingLevelMap: { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" },
				},
			},
		},
		{
			id: "gemini-3-flash",
			match: {
				ids: [
					"gemini-3-flash",
					"gemini-3.1-flash-lite",
					"gemini-3.5-flash",
					"gemini-flash-latest",
					"gemini-flash-lite-latest",
				],
				prefixes: ["gemini-3-flash-", "gemini-3.1-flash-", "gemini-3.5-flash-"],
			},
			metadata: { reasoning: true },
			group: GEMINI_GROUP,
			preferredApis: [...GOOGLE_PREFERRED_APIS],
			apis: {
				"google-generative-ai": { thinkingLevelMap: { off: null } },
				"google-vertex": { thinkingLevelMap: { off: null } },
			},
		},
		{
			id: "gemma-4",
			match: { ids: ["gemma-4", "gemma4"], prefixes: ["gemma-4-", "gemma4-"] },
			metadata: { reasoning: true },
			group: { id: "gemma", label: "Gemma" },
			preferredApis: ["google-generative-ai"],
			apis: {
				"google-generative-ai": {
					thinkingLevelMap: { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" },
				},
			},
		},
		// cd00a0d9^: mistral-conversations.ts usesReasoningEffort() and mapReasoningEffort().
		{
			id: "mistral-reasoning-effort",
			match: { ids: ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5"] },
			metadata: { reasoning: true },
			group: { id: "mistral", label: "Mistral" },
			preferredApis: ["mistral-conversations"],
			apis: {
				"mistral-conversations": {
					thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high" },
				},
			},
		},
		{
			id: "mistral",
			match: { ids: ["mistral"], prefixes: ["mistral-"] },
			group: { id: "mistral", label: "Mistral" },
			preferredApis: ["mistral-conversations"],
		},
		// cd00a0d9^: ANT_LING_RING_THINKING_LEVEL_MAP and antLingCompat.
		{
			id: "ant-ling",
			match: { ids: ["Ling-2.6-flash", "Ling-2.6-1T", "Ring-2.6-1T"] },
			group: { id: "ant-ling", label: "Ant Ling" },
			preferredApis: ["openai-completions"],
			apis: {
				"openai-completions": {
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						maxTokensField: "max_tokens",
						supportsLongCacheRetention: false,
					},
				},
			},
		},
	],
	models: [
		// cd00a0d9^: generate-models.ts deepseekV4Models.
		{
			id: "deepseek-v4-flash",
			metadata: {
				name: "DeepSeek V4 Flash",
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
			},
			apis: {
				"openai-completions": {
					thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
				},
			},
		},
		{
			id: "deepseek-v4-pro",
			metadata: {
				name: "DeepSeek V4 Pro",
				cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
			},
		},
		// cd00a0d9^: generate-models.ts z.ai GLM 5.2 special case.
		{
			id: "glm-5.2",
			metadata: { reasoning: true, toolCall: true },
			apis: {
				"openai-completions": {
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: true,
						thinkingFormat: "zai",
					},
					thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", max: "max" },
				},
			},
		},
		// cd00a0d9^: KIMI_K3_* plus Moonshot K3 replay/deferred-tools overrides.
		{
			id: "kimi-k3",
			metadata: {
				name: "Kimi K3",
				reasoning: true,
				toolCall: true,
				maxTokens: 131_072,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			},
			apis: {
				"openai-completions": {
					compat: { requiresReasoningContentOnAssistantMessages: true, deferredToolsMode: "kimi" },
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: "low",
						medium: null,
						high: "high",
						xhigh: null,
						max: "max",
					},
				},
			},
		},
		// cd00a0d9^: Kimi K2.7 Code is always-thinking; disabling thinking is rejected.
		{
			id: "kimi-k2.7-code",
			metadata: { reasoning: true, toolCall: true },
			apis: { "openai-completions": { thinkingLevelMap: { off: null } } },
		},
		{
			id: "kimi-k2.7-code-highspeed",
			metadata: { reasoning: true, toolCall: true },
			apis: { "openai-completions": { thinkingLevelMap: { off: null } } },
		},
		// cd00a0d9^: OPENAI_RESPONSES_NONE_REASONING_MODELS and OPENAI_TOOL_SEARCH_MODEL_IDS.
		{
			id: "gpt-5.2",
			apis: { "openai-responses": { thinkingLevelMap: { off: "none" } } },
		},
		{
			id: "gpt-5.3-codex",
			apis: { "openai-responses": { thinkingLevelMap: { off: "none" } } },
		},
		{
			id: "gpt-5.4",
			metadata: {
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 2.5,
					output: 15,
					cacheRead: 0.25,
					cacheWrite: 0,
					tiers: [
						{
							inputTokensAbove: 272_000,
							input: 5,
							output: 22.5,
							cacheRead: 0.5,
							cacheWrite: 0,
						},
					],
				},
			},
			apis: {
				"openai-responses": { compat: { supportsToolSearch: true }, thinkingLevelMap: { off: "none" } },
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5.4-mini",
			apis: {
				"openai-responses": { compat: { supportsToolSearch: true }, thinkingLevelMap: { off: "none" } },
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5.4-nano",
			apis: { "openai-responses": { thinkingLevelMap: { off: "none" } } },
		},
		{
			id: "gpt-5.4-pro",
			apis: {
				"openai-responses": { compat: { supportsToolSearch: true } },
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5.5",
			metadata: {
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 5,
					output: 30,
					cacheRead: 0.5,
					cacheWrite: 0,
					tiers: [
						{
							inputTokensAbove: 272_000,
							input: 10,
							output: 45,
							cacheRead: 1,
							cacheWrite: 0,
						},
					],
				},
			},
			apis: {
				"openai-responses": {
					compat: { supportsToolSearch: true },
					thinkingLevelMap: { off: "none", minimal: null },
				},
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5.5-pro",
			apis: {
				"openai-completions": { thinkingLevelMap: { off: null, minimal: null, low: null } },
				"openai-responses": { thinkingLevelMap: { off: null, minimal: null, low: null } },
				"openai-codex-responses": { thinkingLevelMap: { off: null, minimal: null, low: null } },
			},
		},
		// cd00a0d9^: missingOpenAiModels and withOpenAiLongContextPricing().
		{
			id: "gpt-5.6-sol",
			metadata: {
				name: "GPT-5.6 Sol",
				reasoning: true,
				vision: true,
				toolCall: true,
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 5,
					output: 30,
					cacheRead: 0.5,
					cacheWrite: 6.25,
					tiers: [
						{
							inputTokensAbove: 272_000,
							input: 10,
							output: 45,
							cacheRead: 1,
							cacheWrite: 12.5,
						},
					],
				},
			},
			apis: {
				"openai-responses": { compat: { supportsToolSearch: true }, thinkingLevelMap: { off: "none" } },
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5.6-terra",
			metadata: {
				name: "GPT-5.6 Terra",
				reasoning: true,
				vision: true,
				toolCall: true,
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 2.5,
					output: 15,
					cacheRead: 0.25,
					cacheWrite: 3.125,
					tiers: [
						{
							inputTokensAbove: 272_000,
							input: 5,
							output: 22.5,
							cacheRead: 0.5,
							cacheWrite: 6.25,
						},
					],
				},
			},
			apis: {
				"openai-responses": { compat: { supportsToolSearch: true }, thinkingLevelMap: { off: "none" } },
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5.6-luna",
			metadata: {
				name: "GPT-5.6 Luna",
				reasoning: true,
				vision: true,
				toolCall: true,
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: {
					input: 1,
					output: 6,
					cacheRead: 0.1,
					cacheWrite: 1.25,
					tiers: [
						{
							inputTokensAbove: 272_000,
							input: 2,
							output: 9,
							cacheRead: 0.2,
							cacheWrite: 2.5,
						},
					],
				},
			},
			apis: {
				"openai-responses": { compat: { supportsToolSearch: true }, thinkingLevelMap: { off: "none" } },
				"openai-codex-responses": { compat: { supportsToolSearch: true } },
			},
		},
		{
			id: "gpt-5-pro",
			group: GPT_GROUP,
			preferredApis: [...OPENAI_PREFERRED_APIS],
			metadata: { maxTokens: 128_000 },
		},
		// cd00a0d9^: XAI_RESPONSES_* for the official Grok 4.5 Responses endpoint.
		{
			id: "grok-4.5",
			metadata: { reasoning: true, toolCall: true },
			group: { id: "grok", label: "Grok" },
			preferredApis: ["openai-responses"],
			apis: {
				"openai-responses": {
					compat: { supportsLongCacheRetention: false },
					thinkingLevelMap: { off: null, minimal: null },
				},
			},
		},
		// cd00a0d9^: explicit Mistral Medium 3.5 fallback model.
		{
			id: "mistral-medium-3.5",
			metadata: {
				name: "Mistral Medium 3.5",
				reasoning: true,
				vision: true,
				toolCall: true,
				contextWindow: 262_144,
				maxTokens: 262_144,
				cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
			},
		},
		// cd00a0d9^: explicit official Ant Ling catalog.
		{
			id: "Ling-2.6-flash",
			metadata: {
				name: "Ling 2.6 Flash",
				reasoning: false,
				vision: false,
				toolCall: true,
				contextWindow: 262_144,
				maxTokens: 65_536,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			},
		},
		{
			id: "Ling-2.6-1T",
			metadata: {
				name: "Ling 2.6 1T",
				reasoning: false,
				vision: false,
				toolCall: true,
				contextWindow: 262_144,
				maxTokens: 65_536,
				cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			},
		},
		{
			id: "Ring-2.6-1T",
			metadata: {
				name: "Ring 2.6 1T",
				reasoning: true,
				vision: false,
				toolCall: true,
				contextWindow: 262_144,
				maxTokens: 65_536,
				cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			},
			apis: {
				"openai-completions": {
					compat: { thinkingFormat: "ant-ling" },
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: null,
						medium: null,
						high: "high",
						xhigh: "xhigh",
					},
				},
			},
		},
	],
};

export const BUILTIN_COMPAT_REGISTRY = compileCompatRegistry(builtinCompatRegistryData);
