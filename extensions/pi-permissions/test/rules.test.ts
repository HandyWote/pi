import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyRuleCollection, matchContentRules, matchToolRules, PermissionRuleStore } from "../src/rules/index.ts";

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-test-"));
	tempRoots.push(root);
	return root;
}

describe("matchToolRules", () => {
	it("deny beats allow", () => {
		const c = emptyRuleCollection();
		c.user.deny.push({ toolName: "bash" });
		c.user.allow.push({ toolName: "bash" });
		const v = matchToolRules(c, "bash");
		expect(v.deny).toBeDefined();
		expect(v.allow).toBeUndefined();
	});

	it("ask beats allow", () => {
		const c = emptyRuleCollection();
		c.user.ask.push({ toolName: "bash" });
		c.user.allow.push({ toolName: "bash" });
		const v = matchToolRules(c, "bash");
		expect(v.ask).toBeDefined();
		expect(v.allow).toBeUndefined();
	});

	it("matches tool names case-insensitively", () => {
		const c = emptyRuleCollection();
		c.user.allow.push({ toolName: "Bash" });
		expect(matchToolRules(c, "bash").allow?.source).toBe("user");
	});

	it("project allow applies when no user rule matches", () => {
		const c = emptyRuleCollection();
		c.project.allow.push({ toolName: "bash" });
		const v = matchToolRules(c, "bash");
		expect(v.allow?.source).toBe("project");
	});

	it("user deny shadows project allow", () => {
		const c = emptyRuleCollection();
		c.user.deny.push({ toolName: "bash" });
		c.project.allow.push({ toolName: "bash" });
		const v = matchToolRules(c, "bash");
		expect(v.deny).toBeDefined();
		expect(v.allow).toBeUndefined();
	});

	it("user ask shadows project allow", () => {
		const c = emptyRuleCollection();
		c.user.ask.push({ toolName: "bash" });
		c.project.allow.push({ toolName: "bash" });
		const v = matchToolRules(c, "bash");
		expect(v.ask).toBeDefined();
	});

	it("session allow applies before user allow", () => {
		const c = emptyRuleCollection();
		c.session.allow.push({ toolName: "bash" });
		c.user.allow.push({ toolName: "bash" });
		const v = matchToolRules(c, "bash");
		expect(v.allow?.source).toBe("session");
	});
});

describe("matchContentRules", () => {
	it("matches content rules against values", () => {
		const c = emptyRuleCollection();
		c.user.deny.push({ toolName: "bash", ruleContent: "rm -rf *" });
		expect(matchContentRules(c, "bash", "rm -rf /").deny).toBeDefined();
		expect(matchContentRules(c, "bash", "git status").deny).toBeUndefined();
	});

	it("whole-tool rules match any content", () => {
		const c = emptyRuleCollection();
		c.user.deny.push({ toolName: "bash" });
		expect(matchContentRules(c, "bash", "anything").deny).toBeDefined();
	});

	it("content rules do not match other tools", () => {
		const c = emptyRuleCollection();
		c.user.deny.push({ toolName: "bash", ruleContent: "rm *" });
		expect(matchContentRules(c, "write", "rm x").deny).toBeUndefined();
	});

	it("project allow with content applies when no user rule matches", () => {
		const c = emptyRuleCollection();
		c.project.allow.push({ toolName: "bash", ruleContent: "npm run build" });
		const v = matchContentRules(c, "bash", "npm run build");
		expect(v.allow?.source).toBe("project");
	});
});

describe("PermissionRuleStore", () => {
	it("loads user rules from disk", async () => {
		const root = tempDir();
		const file = path.join(root, "permissions.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ allow: ["Bash(git:*)"], deny: ["Bash(rm -rf *)"], ask: ["Bash(sudo *)"] }),
		);
		const store = new PermissionRuleStore({
			userRulesPath: file,
			projectRulesPath: path.join(root, "project", ".pi", "permissions.json"),
		});
		await store.reload();
		const c = store.collection();
		expect(c.user.allow).toEqual([{ toolName: "Bash", ruleContent: "git:*" }]);
		expect(c.user.deny).toEqual([{ toolName: "Bash", ruleContent: "rm -rf *" }]);
		expect(c.user.ask).toEqual([{ toolName: "Bash", ruleContent: "sudo *" }]);
	});

	it("returns empty rules for a missing file", async () => {
		const store = new PermissionRuleStore({ userRulesPath: "/nonexistent/x.json" });
		await store.reload();
		expect(store.collection().user.allow).toEqual([]);
	});

	it("skips project rules when the project is untrusted", async () => {
		const root = tempDir();
		const projectFile = path.join(root, ".pi", "permissions.json");
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ allow: ["Bash(git:*)"] }));
		const store = new PermissionRuleStore({
			userRulesPath: path.join(root, "user.json"),
			projectRulesPath: projectFile,
			isProjectTrusted: () => false,
		});
		await store.reload();
		expect(store.collection().project.allow).toEqual([]);
	});

	it("loads project rules only when trusted", async () => {
		const root = tempDir();
		const projectFile = path.join(root, ".pi", "permissions.json");
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ allow: ["Bash(git:*)"] }));
		const store = new PermissionRuleStore({
			userRulesPath: path.join(root, "user.json"),
			projectRulesPath: projectFile,
			isProjectTrusted: () => true,
		});
		await store.reload();
		expect(store.collection().project.allow).toEqual([{ toolName: "Bash", ruleContent: "git:*" }]);
	});

	it("adds and removes user rules with persistence", async () => {
		const root = tempDir();
		const file = path.join(root, "permissions.json");
		const store = new PermissionRuleStore({ userRulesPath: file });
		await store.reload();
		await store.addUserRule("allow", "Bash(git:*)");
		await store.addUserRule("deny", "Bash(rm -rf *)");
		const reloaded = new PermissionRuleStore({ userRulesPath: file });
		await reloaded.reload();
		expect(reloaded.collection().user.allow).toEqual([{ toolName: "Bash", ruleContent: "git:*" }]);
		expect(reloaded.collection().user.deny).toEqual([{ toolName: "Bash", ruleContent: "rm -rf *" }]);
		await reloaded.removeUserRule("allow", "Bash(git:*)");
		const final = new PermissionRuleStore({ userRulesPath: file });
		await final.reload();
		expect(final.collection().user.allow).toEqual([]);
	});

	it("session rules are memory-only and clearable", async () => {
		const store = new PermissionRuleStore();
		store.addSessionAllow("Bash(git:*)");
		expect(store.collection().session.allow).toEqual([{ toolName: "Bash", ruleContent: "git:*" }]);
		store.clearSessionRules();
		expect(store.collection().session.allow).toEqual([]);
	});

	it("throws on a corrupt rules file", async () => {
		const root = tempDir();
		const file = path.join(root, "permissions.json");
		fs.writeFileSync(file, "{ not json");
		const store = new PermissionRuleStore({ userRulesPath: file });
		await expect(store.reload()).rejects.toThrow(/permissions file/);
	});
});
