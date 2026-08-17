import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	getJsonSchemaToolParameters,
	makeStrictJsonSchema,
	resolveJsonSchemaStrictSampling,
} from "../src/api/constrained-sampling.ts";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import type { Tool } from "../src/types.ts";

function makeTool(parameters: Tool["parameters"]): Tool {
	return {
		name: "test_tool",
		description: "Test tool",
		parameters,
	};
}

describe("strict tool schema conversion", () => {
	it("derives strict provider schemas without changing tool definitions", () => {
		const parameters = Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number()),
			metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		});

		const strict = makeStrictJsonSchema(parameters);

		expect(parameters).not.toHaveProperty("additionalProperties");
		expect(parameters.required).toEqual(["path", "metadata"]);
		expect(strict).toMatchObject({
			additionalProperties: false,
			required: ["path", "offset", "metadata", "nullable"],
			properties: {
				offset: { anyOf: [{ type: "number" }, { type: "null" }] },
				metadata: {
					additionalProperties: false,
					required: ["enabled"],
					properties: { enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
				},
				nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
		});
	});

	it("falls back or rejects schemas that cannot be safely converted", () => {
		const cases: Array<{ parameters: Tool["parameters"]; error: string }> = [
			{
				parameters: Type.Object({ metadata: Type.Object({}, { additionalProperties: Type.String() }) }),
				error: "additionalProperties is unsupported",
			},
			{
				parameters: Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]),
				error: "allOf schemas are unsupported",
			},
			{
				parameters: Type.Object({
					value: Type.Union([Type.Object({ nested: Type.String() }), Type.Null()]),
				}),
				error: "object and array unions are unsupported",
			},
			{
				parameters: {
					type: "object",
					properties: { child: { $ref: "https://example.com/child.json" } },
					required: ["child"],
				} as Tool["parameters"],
				error: "$ref schemas are unsupported",
			},
		];

		for (const { parameters, error } of cases) {
			const tool: Tool = {
				...makeTool(parameters),
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			};

			expect(() => makeStrictJsonSchema(parameters)).toThrow(error);
			expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();
			expect(convertResponsesTools([tool], { supportsStrictMode: true })[0]).toMatchObject({
				strict: false,
				parameters,
			});

			tool.constrainedSampling = { type: "json_schema", strict: "require" };
			expect(() => resolveJsonSchemaStrictSampling(tool, true)).toThrow(error);
		}
	});

	it("applies strict conversion only when the provider supports strict mode", () => {
		const parameters = Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number()),
		});
		const tool: Tool = {
			...makeTool(parameters),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};

		expect(resolveJsonSchemaStrictSampling(tool, true)).toBe(true);
		expect(resolveJsonSchemaStrictSampling(tool, false)).toBeUndefined();

		const strictTool = convertResponsesTools([tool], { supportsStrictMode: true })[0];
		expect(strictTool).toMatchObject({ strict: true });
		expect((strictTool as { parameters: unknown }).parameters).not.toEqual(parameters);
		expect(getJsonSchemaToolParameters(tool, true)).not.toBe(parameters);

		const nonStrictTool = convertResponsesTools([tool], { supportsStrictMode: false })[0];
		expect(nonStrictTool).toMatchObject({ parameters });
		expect((nonStrictTool as { strict?: unknown }).strict).toBeUndefined();
	});

	it("does not change tools without constrained sampling config", () => {
		const parameters = Type.Object({ path: Type.String() });
		const tool = makeTool(parameters);

		expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();
		expect(convertResponsesTools([tool])[0]).toMatchObject({ strict: false, parameters });
	});
});
