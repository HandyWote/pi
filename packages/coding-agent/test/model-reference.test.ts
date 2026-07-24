import { describe, expect, it } from "vitest";
import { formatModelReference, getModelReferenceSearchText, parseModelReference } from "../src/core/model-reference.ts";

const model = {
	provider: "openrouter",
	id: "qwen/qwen3-coder:exacto",
	name: "Qwen3 Coder Exacto",
};

describe("model references", () => {
	it("formats a canonical provider/model reference", () => {
		expect(formatModelReference(model)).toBe("openrouter/qwen/qwen3-coder:exacto");
	});

	it("parses and trims a canonical reference while preserving nested model slashes", () => {
		expect(parseModelReference("  openrouter/qwen/qwen3-coder:exacto  ")).toEqual({
			provider: "openrouter",
			modelId: "qwen/qwen3-coder:exacto",
		});
	});

	it("rejects references without both provider and model ID", () => {
		for (const value of ["", "model-only", "/model", "provider/", " / "]) {
			expect(parseModelReference(value)).toBeUndefined();
		}
	});

	it("builds search text from the canonical reference and display name", () => {
		expect(getModelReferenceSearchText(model)).toBe("openrouter/qwen/qwen3-coder:exacto Qwen3 Coder Exacto");
	});
});
