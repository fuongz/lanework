---
status: todo
assignees: ["fuongz"]
created_at: 2026-06-29 00:00:00Z
tags: []
---

# Review: Add codex

**How to review:** flip `- [ ]` to `- [x]` for each item you agree with; add a `> note` under any you don't. Implementation starts only after every box is `[x]`.

Add OpenAI **Codex CLI** as a supported MCP client alongside Claude Code. The MCP server (`apps/local/mcp.mjs`) is already client-agnostic; the work is a new `lanework setup codex` path in `apps/local/cli.mjs`, plus docs. Codex registers MCP servers via `~/.codex/config.toml` (`[mcp_servers.<name>]` tables), not via Claude's `claude mcp add` CLI — so the registration mechanism differs.

## Decisions
- [ ] **D1. Command surface.** Ship `lanework setup codex` as a sibling of `setup claude-code` (same entry at `cli.mjs:26`), keeping the existing `claude-code` behavior unchanged.
- [ ] **D2. Registration mechanism.** Prefer shelling out to `codex mcp add <name> -- <cmd>` when the `codex` CLI exists; fall back to editing `~/.codex/config.toml` directly only if no CLI command is available. (Decide which is the primary path.)
- [ ] **D3. TOML shape & idempotency.** Write a `[mcp_servers.lanework]` table with `command`/`args` (e.g. `npx -y @phake/lanework mcp`), merging into any existing `config.toml` without clobbering other servers or user settings; re-running setup should be safe/idempotent.
- [ ] **D4. Refactor vs. branch.** Either introduce a small client registry (`{ "claude-code": …, "codex": … }`) or add a minimal `if (client === "codex")` branch — pick the level of abstraction now so `runSetup()` stays readable.
- [ ] **D5. Dashboard parity.** Decide Codex's default for the auto-open board (`mcp` vs `mcp --no-dashboard`) and whether `--no-dashboard`/`--local`/`--name` flags carry over; `--project` (Claude's user-vs-project scope) may not map to Codex.
- [ ] **D6. No plugin / slash commands for Codex.** Confirm Codex gets MCP tools only (no equivalent of the Claude plugin's `/lanework:*` commands), and document that slash commands remain Claude-Code-only.
- [ ] **D7. Docs update.** Add parallel Codex setup instructions to `README.md`, `apps/local/README.md`, the in-app guide (`packages/shared/src/routes/guide.tsx`), and landing (`landing.tsx`); Codex icons already exist and just need wiring.
- [ ] **D8. CLI help & error handling.** Update usage/`--help` text (`cli.mjs:62-67`, `:105`) and handle a missing `codex` CLI / unwritable config path with a clear manual-fallback message (mirroring the `claude` ENOENT handling).
- [ ] **D9. Verification.** Agree how to validate (no test framework exists today): manual `setup codex` against a real `~/.codex/config.toml`, or add a first lightweight test for the TOML merge logic.
- [ ] **D10. Release.** Bump version across `apps/local/package.json`, `plugin/.claude-plugin/plugin.json`, and the hardcoded `mcp.mjs` server version when Codex support ships, then publish via the existing `@phake/lanework` flow.
