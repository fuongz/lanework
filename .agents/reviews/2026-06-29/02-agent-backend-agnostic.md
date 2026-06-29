---
status: todo
assignees: []
created_at: 2026-06-29 00:00:00Z
priority: medium
tags: ["local", "agents", "backends"]
---

# Review: Backend-agnostic agent dispatch (Cursor CLI / Codex / …)

Follow-up to the local agent dispatcher work (see the `agents` tag). The dispatcher in `apps/local/agent-runner.mjs`
already isolates everything backend-specific into the spawn step — worktree
creation, the registry, run/stop/merge, and status round-trip are all generic. To
support other coding-agent CLIs (Cursor's `cursor-agent`, OpenAI `codex`, etc.) we
need to make **how the agent is launched** pluggable, and decide how backends that
don't speak MCP report progress back to the board.

**Current state:** `LANEWORK_AGENT_BIN` already overrides the binary, but the args
(`-p`, `--mcp-config`, `--permission-mode`, `--allowedTools`, `--max-turns`) and the
stdio MCP-config shape are hardcoded to Claude Code. Swapping the binary alone
won't work — the flags differ per tool.

**How to review:** flip `- [ ]` to `- [x]` for each decision you agree with; add a
`> note` under any you don't.

## Decisions

- [ ] **B1. Backend presets, not just a binary.** Introduce
  `LANEWORK_AGENT_BACKEND` (`claude` | `cursor` | `codex`) selecting a preset that
  knows: the binary, how to pass the prompt (positional vs flag), how to attach the
  lanework MCP server (if supported), and the permission/auto-approve flags. Keep
  `claude` as the default and today's exact behavior.

- [ ] **B2. Escape hatch: `LANEWORK_AGENT_CMD` template.** A free-form command
  template with placeholders (`{prompt}`, `{mcpConfig}`, `{cwd}`, `{cardPath}`) for
  any CLI not covered by a preset. Takes precedence over the preset when set.

- [ ] **B3. Status reporting for non-MCP backends.** The round-trip today relies on
  the agent calling the lanework MCP `toggle_item` / `set_status` tools. Backends
  without MCP can't. Pick a fallback (decision needed):
  - [ ] **(a)** Process-state only — the card shows running/done/failed from the exit
    code; no per-item ticking. Simplest; least rich.
  - [ ] **(b)** A tiny lanework HTTP shim the agent is told to `curl` (e.g. a localhost
    token-scoped endpoint that maps to `toggle_item`/`set_status`).
  - [ ] **(c)** Inject a one-off MCP-compatible bridge only for backends that support
    MCP at all (Cursor does; others may not).

- [ ] **B4. Per-backend auth/availability check.** Preflight that the chosen CLI is
  installed and authenticated; fail the dispatch early with a clear message
  (mirrors today's `claude` ENOENT handling) instead of a cryptic spawn error.

- [ ] **B5. Docs.** Document the env knobs (`LANEWORK_AGENT_BACKEND`,
  `LANEWORK_AGENT_CMD`, existing `LANEWORK_AGENT_*`) in `apps/local/README.md` and
  the main README's MCP/agent section.

## Scope

- [ ] **C1.** Refactor the spawn step in `agent-runner.mjs` into a `resolveBackend()`
  that returns `{ bin, args, mcp }`; everything else (worktree, registry,
  run/stop/merge) is untouched.
- [ ] **C2.** Ship `claude` + one second backend (likely `cursor`) end-to-end to
  prove the abstraction; leave others as template-only.
- [ ] **C3.** Out of scope: non-stdio MCP transports, the hosted app.

## Verification

- [ ] **V1.** `claude` backend behaves exactly as before (no regression).
- [ ] **V2.** A second backend dispatches, runs in its worktree, and at minimum
  reflects running → done/failed on the board.
