import { describe, expect, it } from "vitest";
import { matchRuleContent, parseRuleString, ruleValueToString } from "../src/rules/index.ts";

describe("parseRuleString", () => {
	it("parses tool-only rules", () => {
		expect(parseRuleString("Bash")).toEqual({ toolName: "Bash" });
		expect(parseRuleString("Bash()")).toEqual({ toolName: "Bash" });
	});

	it("parses content rules", () => {
		expect(parseRuleString("Bash(git:*)")).toEqual({ toolName: "Bash", ruleContent: "git:*" });
		expect(parseRuleString("Edit(.git/*)")).toEqual({ toolName: "Edit", ruleContent: ".git/*" });
	});

	it("allows ')' inside content", () => {
		expect(parseRuleString("Bash(echo (a))")).toEqual({ toolName: "Bash", ruleContent: "echo (a)" });
	});

	it("rejects invalid strings", () => {
		expect(parseRuleString("")).toBeNull();
		expect(parseRuleString("Bash(git")).toBeNull();
		expect(parseRuleString("Bash)(")).toBeNull();
		expect(parseRuleString("has space(git)")).toBeNull();
	});

	it("round-trips through ruleValueToString", () => {
		for (const s of ["Bash", "Bash(git:*)", "Edit(.git/*)"]) {
			const parsed = parseRuleString(s);
			expect(parsed).not.toBeNull();
			expect(ruleValueToString(parsed!)).toBe(s);
		}
	});
});

describe("matchRuleContent", () => {
	it("matches exact commands", () => {
		expect(matchRuleContent("git status", "git status")).toBe(true);
		expect(matchRuleContent("git status", "git status --short")).toBe(false);
		expect(matchRuleContent("git status", "git")).toBe(false);
	});

	it("matches legacy prefix syntax", () => {
		expect(matchRuleContent("git:*", "git status")).toBe(true);
		expect(matchRuleContent("git:*", "git")).toBe(true);
		expect(matchRuleContent("git:*", "gits")).toBe(false);
		expect(matchRuleContent("git:*", "other git status")).toBe(false);
	});

	it("matches wildcards", () => {
		expect(matchRuleContent("git add *", "git add a.ts")).toBe(true);
		expect(matchRuleContent("git add *", "git add a.ts b.ts")).toBe(true);
		expect(matchRuleContent("git add *", "git add")).toBe(true); // trailing optional
		expect(matchRuleContent("git*", "git")).toBe(true);
		expect(matchRuleContent("git*", "gits status")).toBe(true);
		expect(matchRuleContent("* run *", "npm run build")).toBe(true);
		expect(matchRuleContent("* run *", "npm run")).toBe(false);
	});

	it("wildcards match newlines", () => {
		expect(matchRuleContent("cat *", "cat a\nb")).toBe(true);
	});

	it("honors \\* and \\\\ escapes", () => {
		expect(matchRuleContent("rm \\*", "rm *")).toBe(true);
		expect(matchRuleContent("rm \\*", "rm a")).toBe(false);
		expect(matchRuleContent("echo \\\\", "echo \\")).toBe(true);
		expect(matchRuleContent("a\\*b", "a*b")).toBe(true);
		expect(matchRuleContent("a\\*b", "axb")).toBe(false);
	});

	it("is case-sensitive for commands", () => {
		expect(matchRuleContent("GIT status", "git status")).toBe(false);
	});
});
