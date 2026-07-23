import { describe, expect, it } from "vitest";
import {
	BUILTIN_COMPAT_REGISTRY,
	lookupCompatOverlay,
	lookupModelCompatOverlay,
	type RegistryApi,
} from "../src/compat-registry/index.ts";

const expectedFamilyIds = [
	"deepseek-v4",
	"glm",
	"kimi",
	"gpt-5.2",
	"gpt-5.3",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6",
	"claude-fable-5",
	"claude-opus-4.7-4.8",
	"claude-sonnet-5",
	"claude-opus-sonnet-4.6",
	"claude-4.5-tool-references",
	"claude",
	"gemini-3-pro",
	"gemini-3-flash",
	"gemma-4",
	"mistral-reasoning-effort",
	"mistral",
	"ant-ling",
];

const expectedModelIds = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"glm-5.2",
	"kimi-k3",
	"kimi-k2.7-code",
	"kimi-k2.7-code-highspeed",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5-pro",
	"grok-4.5",
	"mistral-medium-3.5",
	"Ling-2.6-flash",
	"Ling-2.6-1T",
	"Ring-2.6-1T",
];

interface RuleCase {
	name: string;
	modelId: string;
	api: RegistryApi;
	expected: object;
}

const ruleCases: RuleCase[] = [
	{
		name: "DeepSeek V4 native completions",
		modelId: "deepseek-v4-pro",
		api: "openai-completions",
		expected: {
			metadata: { reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 },
			group: { id: "deepseek", label: "DeepSeek" },
			preferredApis: ["openai-completions"],
			compat: {
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				requiresToolSchemaRequiredArray: true,
			},
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
		},
	},
	{
		name: "GLM 5.2 z.ai thinking",
		modelId: "glm-5.2",
		api: "openai-completions",
		expected: {
			group: { id: "glm", label: "GLM" },
			compat: { supportsReasoningEffort: true, thinkingFormat: "zai" },
			thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", max: "max" },
		},
	},
	{
		name: "Kimi K3 replay and deferred tools",
		modelId: "kimi-k3",
		api: "openai-completions",
		expected: {
			metadata: { reasoning: true, maxTokens: 131_072, cost: { input: 3, output: 15, cacheRead: 0.3 } },
			compat: {
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				deferredToolsMode: "kimi",
			},
			thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
		},
	},
	{
		name: "Kimi K2.7 always thinking",
		modelId: "kimi-k2.7-code-highspeed",
		api: "openai-completions",
		expected: { metadata: { reasoning: true }, thinkingLevelMap: { off: null } },
	},
	{
		name: "GPT 5.2 Responses none/xhigh",
		modelId: "gpt-5.2",
		api: "openai-responses",
		expected: {
			group: { id: "gpt", label: "GPT" },
			thinkingLevelMap: { off: "none", xhigh: "xhigh" },
		},
	},
	{
		name: "GPT 5.3 Codex minimal mapping",
		modelId: "gpt-5.3-codex",
		api: "openai-codex-responses",
		expected: { thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } },
	},
	{
		name: "GPT 5.4 tool search",
		modelId: "gpt-5.4-pro",
		api: "openai-responses",
		expected: { compat: { supportsToolSearch: true }, thinkingLevelMap: { off: null, xhigh: "xhigh" } },
	},
	{
		name: "GPT 5.5 direct restriction",
		modelId: "gpt-5.5",
		api: "openai-responses",
		expected: {
			metadata: { contextWindow: 272_000, maxTokens: 128_000 },
			compat: { supportsToolSearch: true },
			thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
		},
	},
	{
		name: "GPT 5.5 Pro supported levels",
		modelId: "gpt-5.5-pro",
		api: "openai-completions",
		expected: { thinkingLevelMap: { off: null, minimal: null, low: null, xhigh: "xhigh" } },
	},
	{
		name: "GPT 5.6 max and pricing",
		modelId: "gpt-5.6-sol",
		api: "openai-responses",
		expected: {
			metadata: {
				contextWindow: 272_000,
				maxTokens: 128_000,
				cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			},
			compat: { supportsToolSearch: true },
			thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
		},
	},
	{
		name: "Claude 4.6 adaptive thinking",
		modelId: "claude-sonnet-4-6",
		api: "anthropic-messages",
		expected: {
			metadata: { reasoning: true, contextWindow: 1_000_000 },
			compat: { forceAdaptiveThinking: true, supportsToolReferences: true },
			thinkingLevelMap: { max: "max" },
		},
	},
	{
		name: "Claude Opus 4.8 temperature restriction",
		modelId: "claude-opus-4-8",
		api: "anthropic-messages",
		expected: {
			compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsToolReferences: true },
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		},
	},
	{
		name: "Claude Sonnet 5 native xhigh",
		modelId: "claude-sonnet-5",
		api: "anthropic-messages",
		expected: { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
	},
	{
		name: "Claude Fable 5 cannot disable thinking",
		modelId: "claude-fable-5",
		api: "anthropic-messages",
		expected: { thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
	},
	{
		name: "Claude 4.5 tool references",
		modelId: "claude-opus-4-5-20251101",
		api: "anthropic-messages",
		expected: { compat: { supportsToolReferences: true } },
	},
	{
		name: "Gemini 3 Pro levels",
		modelId: "gemini-3.1-pro-preview",
		api: "google-generative-ai",
		expected: {
			group: { id: "gemini", label: "Gemini" },
			thinkingLevelMap: { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" },
		},
	},
	{
		name: "Gemini 3 Flash cannot fully disable thinking",
		modelId: "gemini-flash-latest",
		api: "google-vertex",
		expected: { thinkingLevelMap: { off: null } },
	},
	{
		name: "Gemma 4 levels",
		modelId: "gemma-4-31b-it",
		api: "google-generative-ai",
		expected: { thinkingLevelMap: { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" } },
	},
	{
		name: "Grok 4.5 Responses restrictions",
		modelId: "grok-4.5",
		api: "openai-responses",
		expected: {
			compat: { supportsLongCacheRetention: false },
			thinkingLevelMap: { off: null, minimal: null },
		},
	},
	{
		name: "Mistral reasoning effort",
		modelId: "mistral-small-2603",
		api: "mistral-conversations",
		expected: {
			preferredApis: ["mistral-conversations"],
			thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high" },
		},
	},
	{
		name: "Mistral Medium 3.5 metadata",
		modelId: "mistral-medium-3.5",
		api: "mistral-conversations",
		expected: {
			metadata: {
				name: "Mistral Medium 3.5",
				contextWindow: 262_144,
				maxTokens: 262_144,
				cost: { input: 1.5, output: 7.5 },
			},
		},
	},
	{
		name: "Ant Ling Ring effort",
		modelId: "Ring-2.6-1T",
		api: "openai-completions",
		expected: {
			metadata: { reasoning: true, contextWindow: 262_144, maxTokens: 65_536 },
			compat: { thinkingFormat: "ant-ling", supportsReasoningEffort: false },
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" },
		},
	},
];

describe("builtin compatibility registry", () => {
	it("contains every audited family and exact model entry", () => {
		expect(BUILTIN_COMPAT_REGISTRY.families.map(({ entry }) => entry.id)).toEqual(expectedFamilyIds);
		expect([...new Set(BUILTIN_COMPAT_REGISTRY.models.values())].map(({ id }) => id)).toEqual(expectedModelIds);
	});

	it.each(ruleCases)("applies $name", ({ modelId, api, expected }) => {
		expect(lookupCompatOverlay([BUILTIN_COMPAT_REGISTRY], modelId, api)).toMatchObject(expected);
	});

	it("keeps API overlays isolated", () => {
		expect(
			lookupCompatOverlay([BUILTIN_COMPAT_REGISTRY], "deepseek-v4-pro", "openai-responses")?.compat,
		).toBeUndefined();
		expect(
			lookupCompatOverlay([BUILTIN_COMPAT_REGISTRY], "gemini-3.1-pro-preview", "openai-completions")
				?.thinkingLevelMap,
		).toBeUndefined();
	});

	it("does not restore removed aliases or transport-specific variants", () => {
		expect(lookupModelCompatOverlay([BUILTIN_COMPAT_REGISTRY], "gpt-5.6")).toBeUndefined();
		expect(lookupModelCompatOverlay([BUILTIN_COMPAT_REGISTRY], "deepseek-v40-pro")).toBeUndefined();
		expect(lookupModelCompatOverlay([BUILTIN_COMPAT_REGISTRY], "z-ai/glm-5.2")).toBeUndefined();
		expect(lookupModelCompatOverlay([BUILTIN_COMPAT_REGISTRY], "moonshotai/kimi-k3")).toBeUndefined();
	});
});
