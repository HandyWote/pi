# pi-permissions

Security gate for pi: permission modes, rules, bash analysis, and an AI classifier — Claude Code-style tool-call gating, implemented as a pure extension (no core changes).

Every tool call passes a gate before it executes. The outcome is one of:

- **allow** — runs automatically (rule, redline-clean read, or classifier approval)
- **deny** — blocked; the reason is returned to the model as a tool error
- **ask** — the user decides (interactive dialog) or it is auto-denied (headless)

Precedence, all modes: **redline > deny rules > ask rules > allow rules**.

## Install

```bash
pi install npm:@handy_wote/pi-permissions
```

## Modes

| Mode | Behavior |
| --- | --- |
| `chat` (default) | `ls`/`grep`/`find`/`read` (non-sensitive paths) auto-allowed; `bash`, `edit`, `write` always asked |
| `acceptEdits` | `edit`/`write` auto-allowed (inside the project); `bash` unchanged; redlines still ask |
| `auto` | An AI classifier (the session's current Anthropic model) decides for everything `chat` would ask. Fail-closed: classifier errors/timeouts block. After 3 consecutive or 20 total classifier denials, interactive sessions fall back to asking the user |

Switch modes with `/permissions mode <chat|acceptEdits|auto>` or `--permissions-mode`.

## Rules

Rules use the `Tool(content)` syntax, matching Claude Code:

```jsonc
// ~/.pi/permissions.json (user level — applies everywhere)
{
  "allow": ["Bash(git:*)", "Bash(npm run build)", "Read(src/*)"],
  "deny":  ["Bash(rm -rf *)"],
  "ask":   ["Bash(sudo *)"]
}
```

- Content forms: exact (`Bash(npm run build)`), legacy prefix (`Bash(git:*)`), wildcard (`Bash(git add *)`, `\*` escapes a literal star).
- `bash` commands are split into subcommands (tree-sitter); rules match each subcommand individually and the dialog lists which parts need approval. Commands that cannot be parsed statically are always asked (never auto-allowed).
- Project rules (`.pi/permissions.json`, allow only) load only for trusted projects and are always shadowed by user rules: a user `deny`/`ask` beats a project `allow`.
- Session rules ("Allow this session") are memory-only and cleared on session start.

## Redlines

The following can never be auto-allowed (any mode):

- writes inside `.git/`, `.pi/`, `.claude/`
- writes to shell config files in your home directory (`~/.bashrc`, `~/.zshrc`, `~/.profile`, ...)
- reads or writes under `~/.ssh/`

## Headless behavior (print / json / rpc)

Rules fully apply; asks are auto-denied (fail-closed) with a tool error that explains the reason and how to fix it: switch to the interactive TUI, or pre-authorize via CLI flags:

```bash
pi --permissions-mode=acceptEdits -p "refactor this"
pi --permissions-allow "Bash(rm -rf dist)" -p "clean the build output"
```

`--permissions-allow` / `--permissions-deny` are one-shot (session only, not persisted).

## Commands and flags

- `/permissions` — show mode and rules; `mode <m>`, `allow|deny|ask <rule>`, `remove <behavior> <rule>`, `session [clear]`
- `--permissions-mode=chat|acceptEdits|auto`
- `--permissions-allow="Bash(git:*)"` — one-shot allow rule
- `--permissions-deny="Bash(rm *)"` — one-shot deny rule

## Audit

Every denial is appended to `~/.pi/permissions/denials.jsonl` (timestamp, tool, command, reason, mode, headless). The log is capped at 5000 lines (oldest half dropped).

## Extension API for other UI authors

The decision engine is UI-independent. `createPiPermissions(options)` accepts `tuiAsker`/`headlessAsker` overrides and a `classify` override, so other UIs can plug in their own dialogs or classifier. Ask requests are plain data (`PermissionAsk`): tool name, description, reason, details.
