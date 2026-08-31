import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

describe("issue #8255 nested markdown skills in .agents/skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-8255-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers nested markdown skills in .agents/skills while ignoring root markdown files", async () => {
		const agentsSkillsDir = join(cwd, ".agents", "skills");
		mkdirSync(join(agentsSkillsDir, "nested-skill"), { recursive: true });
		mkdirSync(join(agentsSkillsDir, "third-party"), { recursive: true });
		mkdirSync(join(agentsSkillsDir, "third-party", "vendor", "pack"), { recursive: true });

		// Root markdown files in .agents/skills must be ignored.
		writeFileSync(join(agentsSkillsDir, "root-file.md"), "---\nname: root-file\ndescription: Root file\n---\n");
		writeFileSync(join(agentsSkillsDir, "README.md"), "# Shared skills\n\nDocumentation.");

		// Nested markdown files declaring skill frontmatter are discovered.
		const nestedMarkdownSkill = join(agentsSkillsDir, "third-party", "child-skill.md");
		const deeplyNestedMarkdownSkill = join(agentsSkillsDir, "third-party", "vendor", "pack", "deep-skill.md");
		writeFileSync(nestedMarkdownSkill, "---\nname: child-skill\ndescription: Nested markdown skill\n---\n");
		writeFileSync(deeplyNestedMarkdownSkill, "---\nname: deep-skill\ndescription: Deep markdown skill\n---\n");

		// Nested SKILL.md is still discovered.
		writeFileSync(
			join(agentsSkillsDir, "nested-skill", "SKILL.md"),
			"---\nname: nested-skill\ndescription: Nested skill\n---\n",
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		expect(skills.some((s) => s.filePath === join(agentsSkillsDir, "root-file.md"))).toBe(false);
		expect(skills.some((s) => s.filePath === join(agentsSkillsDir, "README.md"))).toBe(false);
		expect(skills.some((s) => s.filePath === nestedMarkdownSkill)).toBe(true);
		expect(skills.some((s) => s.filePath === deeplyNestedMarkdownSkill)).toBe(true);
		expect(skills.some((s) => s.filePath === join(agentsSkillsDir, "nested-skill", "SKILL.md"))).toBe(true);
	});
});
