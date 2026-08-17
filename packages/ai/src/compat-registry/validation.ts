import { type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type {
	CompiledModelCompatRegistry,
	CompiledRegistryMatcher,
	ModelCompatFamily,
	ModelCompatModel,
	ModelCompatRegistry,
} from "./types.ts";

const strict = { additionalProperties: false } as const;
const nonEmptyString = Type.String({ minLength: 1 });
const nonNegativeNumber = Type.Number({ minimum: 0 });
const positiveInteger = Type.Integer({ minimum: 1 });
const stringArray = Type.Array(nonEmptyString);
const registryApi = Type.Union([
	Type.Literal("openai-completions"),
	Type.Literal("openai-responses"),
	Type.Literal("openai-codex-responses"),
	Type.Literal("anthropic-messages"),
	Type.Literal("mistral-conversations"),
	Type.Literal("google-generative-ai"),
	Type.Literal("google-vertex"),
]);
const sessionAffinityFormat = Type.Union([
	Type.Literal("openai"),
	Type.Literal("openai-nosession"),
	Type.Literal("openrouter"),
]);
const thinkingLevelMap = Type.Object(
	{
		off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		max: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	strict,
);

const percentileThresholds = Type.Object(
	{
		p50: Type.Optional(Type.Number()),
		p75: Type.Optional(Type.Number()),
		p90: Type.Optional(Type.Number()),
		p99: Type.Optional(Type.Number()),
	},
	strict,
);
const openRouterRouting = Type.Object(
	{
		allow_fallbacks: Type.Optional(Type.Boolean()),
		require_parameters: Type.Optional(Type.Boolean()),
		data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
		zdr: Type.Optional(Type.Boolean()),
		enforce_distillable_text: Type.Optional(Type.Boolean()),
		order: Type.Optional(stringArray),
		only: Type.Optional(stringArray),
		ignore: Type.Optional(stringArray),
		quantizations: Type.Optional(stringArray),
		sort: Type.Optional(
			Type.Union([
				Type.String(),
				Type.Object(
					{
						by: Type.Optional(Type.String()),
						partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					},
					strict,
				),
			]),
		),
		max_price: Type.Optional(
			Type.Object(
				{
					prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
				},
				strict,
			),
		),
		preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), percentileThresholds])),
		preferred_max_latency: Type.Optional(Type.Union([Type.Number(), percentileThresholds])),
	},
	strict,
);
const vercelGatewayRouting = Type.Object(
	{
		only: Type.Optional(stringArray),
		order: Type.Optional(stringArray),
	},
	strict,
);
const chatTemplateKwargValue = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Object(
		{
			$var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")]),
			omitWhenOff: Type.Optional(Type.Boolean()),
		},
		strict,
	),
]);

const openAICompletionsCompat = Type.Object(
	{
		supportsStore: Type.Optional(Type.Boolean()),
		supportsDeveloperRole: Type.Optional(Type.Boolean()),
		supportsReasoningEffort: Type.Optional(Type.Boolean()),
		supportsUsageInStreaming: Type.Optional(Type.Boolean()),
		supportsFinishReason: Type.Optional(Type.Boolean()),
		maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
		requiresToolResultName: Type.Optional(Type.Boolean()),
		requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
		requiresThinkingAsText: Type.Optional(Type.Boolean()),
		requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
		requiresToolSchemaRequiredArray: Type.Optional(Type.Boolean()),
		thinkingFormat: Type.Optional(
			Type.Union([
				Type.Literal("openai"),
				Type.Literal("openrouter"),
				Type.Literal("deepseek"),
				Type.Literal("together"),
				Type.Literal("zai"),
				Type.Literal("qwen"),
				Type.Literal("chat-template"),
				Type.Literal("qwen-chat-template"),
				Type.Literal("string-thinking"),
				Type.Literal("ant-ling"),
			]),
		),
		chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), chatTemplateKwargValue)),
		openRouterRouting: Type.Optional(openRouterRouting),
		vercelGatewayRouting: Type.Optional(vercelGatewayRouting),
		zaiToolStream: Type.Optional(Type.Boolean()),
		supportsStrictMode: Type.Optional(Type.Boolean()),
		cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
		sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
		deferredToolsMode: Type.Optional(Type.Literal("kimi")),
		sessionAffinityFormat: Type.Optional(sessionAffinityFormat),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	},
	strict,
);
const openAIResponsesCompat = Type.Object(
	{
		supportsDeveloperRole: Type.Optional(Type.Boolean()),
		sessionAffinityFormat: Type.Optional(sessionAffinityFormat),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
		supportsStrictMode: Type.Optional(Type.Boolean()),
		supportsToolSearch: Type.Optional(Type.Boolean()),
	},
	strict,
);
const anthropicMessagesCompat = Type.Object(
	{
		supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
		sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
		supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
		supportsTemperature: Type.Optional(Type.Boolean()),
		forceAdaptiveThinking: Type.Optional(Type.Boolean()),
		allowEmptySignature: Type.Optional(Type.Boolean()),
		supportsStrictTools: Type.Optional(Type.Boolean()),
		supportsToolReferences: Type.Optional(Type.Boolean()),
	},
	strict,
);
const apiOverlay = (compat: TSchema) =>
	Type.Object(
		{
			compat: Type.Optional(compat),
			thinkingLevelMap: Type.Optional(thinkingLevelMap),
		},
		strict,
	);
const mapOnlyApiOverlay = Type.Object(
	{
		thinkingLevelMap: Type.Optional(thinkingLevelMap),
	},
	strict,
);
const apiOverlays = Type.Object(
	{
		"openai-completions": Type.Optional(apiOverlay(openAICompletionsCompat)),
		"openai-responses": Type.Optional(apiOverlay(openAIResponsesCompat)),
		"openai-codex-responses": Type.Optional(apiOverlay(openAIResponsesCompat)),
		"anthropic-messages": Type.Optional(apiOverlay(anthropicMessagesCompat)),
		"mistral-conversations": Type.Optional(mapOnlyApiOverlay),
		"google-generative-ai": Type.Optional(mapOnlyApiOverlay),
		"google-vertex": Type.Optional(mapOnlyApiOverlay),
	},
	strict,
);

const costRates = {
	input: nonNegativeNumber,
	output: nonNegativeNumber,
	cacheRead: nonNegativeNumber,
	cacheWrite: nonNegativeNumber,
};
const costTier = Type.Object({ ...costRates, inputTokensAbove: positiveInteger }, strict);
const cost = Type.Object(
	{
		input: Type.Optional(nonNegativeNumber),
		output: Type.Optional(nonNegativeNumber),
		cacheRead: Type.Optional(nonNegativeNumber),
		cacheWrite: Type.Optional(nonNegativeNumber),
		tiers: Type.Optional(Type.Array(costTier)),
	},
	strict,
);
const metadata = Type.Object(
	{
		name: Type.Optional(nonEmptyString),
		reasoning: Type.Optional(Type.Boolean()),
		vision: Type.Optional(Type.Boolean()),
		toolCall: Type.Optional(Type.Boolean()),
		contextWindow: Type.Optional(positiveInteger),
		maxTokens: Type.Optional(positiveInteger),
		cost: Type.Optional(cost),
	},
	strict,
);
const group = Type.Object({ id: nonEmptyString, label: nonEmptyString }, strict);
const modelOverlay = {
	metadata: Type.Optional(metadata),
	group: Type.Optional(group),
	preferredApis: Type.Optional(Type.Array(registryApi, { uniqueItems: true })),
	apis: Type.Optional(apiOverlays),
};
const matcher = Type.Object(
	{
		ids: Type.Optional(Type.Array(nonEmptyString, { minItems: 1, uniqueItems: true })),
		prefixes: Type.Optional(Type.Array(nonEmptyString, { minItems: 1, uniqueItems: true })),
	},
	{ ...strict, minProperties: 1 },
);
const family = Type.Object({ id: nonEmptyString, match: matcher, ...modelOverlay }, strict);
const model = Type.Object(
	{
		id: nonEmptyString,
		aliases: Type.Optional(Type.Array(nonEmptyString, { uniqueItems: true })),
		...modelOverlay,
	},
	strict,
);

export const ModelCompatRegistrySchema = Type.Object(
	{
		version: Type.Literal(1),
		families: Type.Array(family),
		models: Type.Optional(Type.Array(model)),
	},
	strict,
);

const registryValidator = Compile(ModelCompatRegistrySchema);

export interface CompatRegistryValidationIssue {
	path: string;
	message: string;
}

export type CompatRegistryValidationResult =
	| { success: true; registry: CompiledModelCompatRegistry }
	| { success: false; issues: CompatRegistryValidationIssue[] };

export class CompatRegistryValidationError extends Error {
	readonly issues: CompatRegistryValidationIssue[];

	constructor(issues: CompatRegistryValidationIssue[]) {
		super(
			`Invalid model compatibility registry: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
		);
		this.name = "CompatRegistryValidationError";
		this.issues = issues;
	}
}

function issueFromTypeBox(error: TLocalizedValidationError): CompatRegistryValidationIssue {
	return { path: error.instancePath || "/", message: error.message };
}

function normalized(value: string): string {
	return value.toLowerCase();
}

function validateIdentifiers(registry: ModelCompatRegistry): CompatRegistryValidationIssue[] {
	const issues: CompatRegistryValidationIssue[] = [];
	const familyIds = new Set<string>();
	for (const [familyIndex, entry] of registry.families.entries()) {
		const familyId = normalized(entry.id);
		if (familyIds.has(familyId)) {
			issues.push({ path: `/families/${familyIndex}/id`, message: `Duplicate family id "${entry.id}"` });
		}
		familyIds.add(familyId);

		for (const key of ["ids", "prefixes"] as const) {
			const seen = new Set<string>();
			for (const [valueIndex, value] of (entry.match[key] ?? []).entries()) {
				const normalizedValue = normalized(value);
				if (seen.has(normalizedValue)) {
					issues.push({
						path: `/families/${familyIndex}/match/${key}/${valueIndex}`,
						message: `Duplicate case-insensitive matcher value "${value}"`,
					});
				}
				seen.add(normalizedValue);
			}
		}
	}

	const modelIds = new Map<string, string>();
	for (const [modelIndex, entry] of (registry.models ?? []).entries()) {
		for (const [valueIndex, value] of [entry.id, ...(entry.aliases ?? [])].entries()) {
			const normalizedValue = normalized(value);
			const existing = modelIds.get(normalizedValue);
			if (existing) {
				issues.push({
					path: valueIndex === 0 ? `/models/${modelIndex}/id` : `/models/${modelIndex}/aliases/${valueIndex - 1}`,
					message: `Model id or alias "${value}" conflicts with "${existing}"`,
				});
			} else {
				modelIds.set(normalizedValue, value);
			}
		}
	}
	return issues;
}

function compileMatcher(entry: ModelCompatFamily): CompiledRegistryMatcher {
	return {
		ids: new Set((entry.match.ids ?? []).map(normalized)),
		prefixes: (entry.match.prefixes ?? []).map(normalized),
	};
}

function compileValidatedRegistry(registry: ModelCompatRegistry): CompiledModelCompatRegistry {
	const models = new Map<string, ModelCompatModel>();
	for (const entry of registry.models ?? []) {
		models.set(normalized(entry.id), entry);
		for (const alias of entry.aliases ?? []) {
			models.set(normalized(alias), entry);
		}
	}
	return {
		version: 1,
		families: registry.families.map((entry) => ({ entry, matcher: compileMatcher(entry) })),
		models,
	};
}

export function validateCompatRegistry(value: unknown): CompatRegistryValidationResult {
	if (!registryValidator.Check(value)) {
		return { success: false, issues: registryValidator.Errors(value).map(issueFromTypeBox) };
	}
	const registry = value as ModelCompatRegistry;
	const issues = validateIdentifiers(registry);
	return issues.length > 0
		? { success: false, issues }
		: { success: true, registry: compileValidatedRegistry(registry) };
}

export function compileCompatRegistry(value: unknown): CompiledModelCompatRegistry {
	const result = validateCompatRegistry(value);
	if (!result.success) {
		throw new CompatRegistryValidationError(result.issues);
	}
	return result.registry;
}
