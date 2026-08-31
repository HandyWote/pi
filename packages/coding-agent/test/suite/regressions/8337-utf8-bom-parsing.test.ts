import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStoredCredential } from "../../../src/core/auth-storage.ts";
import { parseFrontmatter } from "../../../src/utils/frontmatter.ts";
import { splitBom, stripBom } from "../../../src/utils/text.ts";

describe("issue #8337 UTF-8 BOM parsing", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-8337-"));
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("splits and strips a leading BOM", () => {
		expect(splitBom("\uFEFFcontent")).toEqual({ bom: "\uFEFF", text: "content" });
		expect(splitBom("content")).toEqual({ bom: "", text: "content" });
		expect(stripBom("\uFEFFcontent")).toBe("content");
		expect(stripBom("content")).toBe("content");
	});

	it("parses frontmatter with a leading BOM", () => {
		const document = "---\nname: demo\ndescription: Test\n---\nBody";
		expect(parseFrontmatter(`\uFEFF${document}`)).toEqual({
			frontmatter: { name: "demo", description: "Test" },
			body: "Body",
		});
	});

	it("loads auth credentials from a BOM-prefixed auth.json", () => {
		const authPath = join(testDir, "auth.json");
		writeFileSync(
			authPath,
			`\uFEFF${JSON.stringify({
				openai: { type: "api_key", key: "sk-test" },
			})}`,
		);

		const credential = readStoredCredential("openai", authPath);
		expect(credential).toEqual({ type: "api_key", key: "sk-test" });
	});
});
