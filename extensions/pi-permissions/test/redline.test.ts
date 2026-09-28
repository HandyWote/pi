import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRedline, type RedlineCheckInput } from "../src/redline.ts";

const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-test-"));
	tempRoots.push(root);
	return root;
}

function check(overrides: Partial<RedlineCheckInput> & { paths: string[] }): ReturnType<typeof checkRedline> {
	return checkRedline({
		toolName: "edit",
		cwd: tempDir(),
		operation: "write",
		...overrides,
	});
}

describe("checkRedline", () => {
	it("blocks writing inside .git", () => {
		const r = check({ paths: [".git/config"] });
		expect(r.hit).toBe(true);
		expect(r.reason).toContain(".git");
	});

	it("blocks writing the .git directory itself", () => {
		const r = check({ paths: [".git"] });
		expect(r.hit).toBe(true);
	});

	it("allows writing ordinary project files", () => {
		const r = check({ paths: ["src/foo.ts", "README.md"] });
		expect(r.hit).toBe(false);
	});

	it("allows reading .git contents", () => {
		const r = check({ paths: [".git/config"], operation: "read" });
		expect(r.hit).toBe(false);
	});

	it("allows reading .gitignore (not inside .git/)", () => {
		expect(check({ paths: [".gitignore"], operation: "read" }).hit).toBe(false);
		expect(check({ paths: [".gitignore"] }).hit).toBe(false);
	});

	it("blocks writing .pi and .claude config dirs", () => {
		expect(check({ paths: [".pi/settings.json"] }).hit).toBe(true);
		expect(check({ paths: [".claude/settings.json"] }).hit).toBe(true);
	});

	it("allows reading .pi and .claude config dirs", () => {
		expect(check({ paths: [".pi/settings.json"], operation: "read" }).hit).toBe(false);
		expect(check({ paths: [".claude/settings.json"], operation: "read" }).hit).toBe(false);
	});

	it("blocks writing shell config files in the home directory", () => {
		for (const name of [".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".zshenv"]) {
			const r = check({ paths: [`~/${name}`] });
			expect(r.hit).toBe(true);
			expect(r.matchedPath).toBe(path.join(os.homedir(), name));
		}
		const fish = check({ paths: ["~/.config/fish/config.fish"] });
		expect(fish.hit).toBe(true);
	});

	it("allows writing shell-config-named files inside the project", () => {
		expect(check({ paths: [".bashrc"] }).hit).toBe(false);
		expect(check({ paths: ["config.fish"] }).hit).toBe(false);
	});

	it("blocks reading and writing inside ~/.ssh", () => {
		const read = check({ paths: ["~/.ssh/id_rsa"], operation: "read" });
		expect(read.hit).toBe(true);
		expect(read.matchedPath).toBe(path.join(os.homedir(), ".ssh", "id_rsa"));

		const write = check({ paths: ["~/.ssh/authorized_keys"] });
		expect(write.hit).toBe(true);
	});

	it("normalizes relative paths and .. segments", () => {
		const r = check({ paths: ["sub/../.git/config"] });
		expect(r.hit).toBe(true);
	});

	it("expands ~ in paths", () => {
		const r = check({ paths: ["~/.ssh/id_rsa"] });
		expect(r.matchedPath).toBe(path.join(os.homedir(), ".ssh", "id_rsa"));
	});

	it("does not hit when bash passes no paths", () => {
		const r = check({ paths: [], toolName: "bash" });
		expect(r).toEqual({ hit: false });
	});
});
