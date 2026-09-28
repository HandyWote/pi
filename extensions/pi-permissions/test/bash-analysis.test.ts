import { describe, expect, it } from "vitest";
import { checkSemantics, parseBashCommand } from "../src/bash-analysis/index.ts";

describe("parseBashCommand", () => {
	it("parses a plain command as simple with its raw text", async () => {
		const result = await parseBashCommand("git status");
		expect(result).toEqual({ kind: "simple", commands: ["git status"] });
	});

	it("splits && chains into separate commands", async () => {
		const result = await parseBashCommand("git add a && npm publish");
		expect(result).toEqual({
			kind: "simple",
			commands: ["git add a", "npm publish"],
		});
	});

	it("splits ; and | chains into separate commands", async () => {
		expect(await parseBashCommand("echo a | grep b")).toEqual({
			kind: "simple",
			commands: ["echo a", "grep b"],
		});
		expect(await parseBashCommand("cd /tmp; ls")).toEqual({
			kind: "simple",
			commands: ["cd /tmp", "ls"],
		});
	});

	it("keeps env assignments out of the command list", async () => {
		const result = await parseBashCommand("VAR=x && echo $VAR");
		expect(result).toEqual({ kind: "simple", commands: ["echo $VAR"] });
		expect(await parseBashCommand("A=1 B=2")).toEqual({
			kind: "simple",
			commands: [],
		});
	});

	it("collects commands inside redirected and negated wrappers", async () => {
		// Trailing redirects are siblings of the command node (same as Claude
		// Code: SimpleCommand.text is the command span, redirects are separate).
		expect(await parseBashCommand("echo hi > out.txt 2>&1")).toEqual({
			kind: "simple",
			commands: ["echo hi"],
		});
		expect(await parseBashCommand("! git diff --quiet")).toEqual({
			kind: "simple",
			commands: ["git diff --quiet"],
		});
	});

	it("marks command substitution as too-complex", async () => {
		expect(await parseBashCommand("echo $(rm -rf /)")).toEqual({
			kind: "too-complex",
			reason: "Contains command_substitution",
		});
		expect(await parseBashCommand("echo `id`")).toEqual({
			kind: "too-complex",
			reason: "Contains command_substitution",
		});
		expect(await parseBashCommand("echo a$(id)b")).toEqual({
			kind: "too-complex",
			reason: "Contains command_substitution",
		});
		expect(await parseBashCommand("VAR=$(id)")).toEqual({
			kind: "too-complex",
			reason: "Contains command_substitution",
		});
	});

	it("marks control flow and function definitions as too-complex", async () => {
		expect(await parseBashCommand("if true; then rm x; fi")).toEqual({
			kind: "too-complex",
			reason: "Contains if_statement",
		});
		for (const cmd of [
			"while true; do echo hi; done",
			"for i in 1 2 3; do echo $i; done",
			"f() { rm -rf /; }",
			"case $x in a) rm x;; esac",
			"{ echo a; echo b; }",
			"(( i++ ))",
		]) {
			expect((await parseBashCommand(cmd)).kind).toBe("too-complex");
		}
	});

	it("allows test commands and arithmetic expansion without substitution", async () => {
		// test_command evaluates to true/false — no code runs; the executing
		// command after && is collected.
		expect(await parseBashCommand("[[ -f /etc/passwd ]] && echo yes")).toEqual({
			kind: "simple",
			commands: ["echo yes"],
		});
		expect(await parseBashCommand("echo $((1+2))")).toEqual({
			kind: "simple",
			commands: ["echo $((1+2))"],
		});
		expect(await parseBashCommand(`echo \${x:-default}`)).toEqual({
			kind: "simple",
			commands: [`echo \${x:-default}`],
		});
	});

	it("rejects arithmetic expansion containing substitution", async () => {
		expect(await parseBashCommand("echo $(( $(id) ))")).toEqual({
			kind: "too-complex",
			reason: "Contains command_substitution",
		});
	});

	it("handles heredocs: quoted bodies are simple, executing bodies reject", async () => {
		expect(await parseBashCommand("cat <<'EOF'\n$(id)\nEOF")).toEqual({
			kind: "simple",
			commands: ["cat"],
		});
		expect((await parseBashCommand("cat <<EOF\n$(id)\nEOF")).kind).toBe("too-complex");
		// A pipeline after the heredoc marker executes and is collected.
		expect(await parseBashCommand("cat <<EOF | grep x\nhello\nEOF")).toEqual({
			kind: "simple",
			commands: ["cat", "grep x"],
		});
	});

	it("marks declarations with eval-like forms as too-complex", async () => {
		expect(await parseBashCommand("export FOO=bar")).toEqual({
			kind: "simple",
			commands: ["export FOO=bar"],
		});
		expect((await parseBashCommand("declare -i x=1")).kind).toBe("too-complex");
		expect((await parseBashCommand("declare -n X=Y")).kind).toBe("too-complex");
		expect((await parseBashCommand("declare 'x[$(id)]=v'")).kind).toBe("too-complex");
		expect((await parseBashCommand("local x=1")).kind).toBe("simple");
		expect((await parseBashCommand("export -n FOO")).kind).toBe("simple");
	});

	it("rejects over-length commands without parsing", async () => {
		const result = await parseBashCommand("a".repeat(10001));
		expect(result).toEqual({
			kind: "too-complex",
			reason: "Command length 10001 exceeds the 10000 character analysis limit",
		});
	});

	it("returns simple with no commands for empty input", async () => {
		expect(await parseBashCommand("")).toEqual({
			kind: "simple",
			commands: [],
		});
		expect(await parseBashCommand("   ")).toEqual({
			kind: "simple",
			commands: [],
		});
	});

	it("rejects control characters and unicode whitespace", async () => {
		expect((await parseBashCommand("echo hi\u0000")).kind).toBe("too-complex");
		expect((await parseBashCommand("echo\u00a0hi")).kind).toBe("too-complex");
		expect((await parseBashCommand("echo a\\ b")).kind).toBe("too-complex");
	});
});

describe("checkSemantics", () => {
	it("allows ordinary commands", async () => {
		expect(checkSemantics(["git status"])).toEqual({ ok: true });
		expect(checkSemantics(["git add a", "npm publish"])).toEqual({
			ok: true,
		});
	});

	it("rejects eval-like builtins", async () => {
		for (const cmd of [
			"eval rm -rf /",
			"exec rm -rf /",
			"source ~/.evil.sh",
			". ~/.evil.sh",
			"shopt -s expand_aliases",
			"trap 'rm -rf /' EXIT",
			"alias rm='echo'",
			"let 'x=a[$(id)]'",
			"builtin eval x",
		]) {
			expect(checkSemantics([cmd])).toEqual({
				ok: false,
				reason: expect.stringContaining("evaluates shell code"),
			});
		}
	});

	it("rejects runtime-determined command names", async () => {
		expect(checkSemantics(["$cmd args"])).toEqual({
			ok: false,
			reason: expect.stringContaining("runtime-determined"),
		});
	});

	it("rejects shell keywords in command position", async () => {
		expect(checkSemantics(["do x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("Shell keyword"),
		});
	});

	it("finds the command name past env assignments and redirects", async () => {
		expect(checkSemantics(["FOO=bar 2>&1 eval x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("'eval'"),
		});
		expect(checkSemantics(["FOO='a b' git status"])).toEqual({ ok: true });
	});

	it("checks the wrapped command behind wrapper prefixes", async () => {
		expect(checkSemantics(["timeout 5 eval x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("'eval'"),
		});
		expect(checkSemantics(["nohup source ~/.x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("'source'"),
		});
		expect(checkSemantics(["env -i eval x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("'eval'"),
		});
		expect(checkSemantics(["time ls"])).toEqual({ ok: true });
		expect(checkSemantics(["time eval x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("'eval'"),
		});
		expect(checkSemantics(["timeout 5 git status"])).toEqual({ ok: true });
	});

	it("fails closed on unanalyzable wrapper flags", async () => {
		expect(checkSemantics(["timeout -Z 5 eval x"])).toEqual({
			ok: false,
			reason: expect.stringContaining("cannot locate the wrapped command"),
		});
		expect(checkSemantics(["env -S 'eval x'"])).toEqual({
			ok: false,
			reason: expect.stringContaining("cannot locate the wrapped command"),
		});
	});

	it("allows command -v lookups", async () => {
		expect(checkSemantics(["command -v git"])).toEqual({ ok: true });
		expect(checkSemantics(["command -V git"])).toEqual({ ok: true });
		expect(checkSemantics(["command rm -rf /"])).toEqual({
			ok: false,
			reason: expect.stringContaining("'command'"),
		});
	});
});
