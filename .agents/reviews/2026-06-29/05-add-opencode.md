---
status: todo
assignees: ["fuongz"]
created_at: 2026-06-29 00:00:00Z
tags: []
---

# Review: Add opencode

**How to review:** flip `- [ ]` to `- [x]` for each item you agree with; add a `> note` under any you don't. Implementation starts only after every box is `[x]`.

Add the [OpenCode](https://opencode.ai) AI coding agent as a first-class lanework integration, mirroring the existing Claude Code support (CLI `setup`, MCP registration, and docs). The catch: OpenCode registers MCP servers through a JSON config file (`opencode.json` / `~/.config/opencode/opencode.json`, an `mcp.<name>` block with `"type": "local"`), not via a `claude mcp add`-style CLI subcommand, so the setup path is structurally different from `cli.mjs`'s current shell-out.

## Decisions
- [ ] **D1. Scope of "add opencode."** Ship (a) a `lanework setup opencode` CLI command + (b) docs/landing/guide listing OpenCode as a supported agent. Defer (slash-command parity, AGENTS.md pickup notes) unless called out below.
- [ ] **D2. Registration mechanism.** Since OpenCode has no `mcp add` CLI, `setup opencode` writes/merges an `mcp.lanework` block into an `opencode.json` config file (rather than spawning a CLI like the claude-code path does at `cli.mjs:128-129`).
- [ ] **D3. Config target & `--project` flag.** Default to the global config (`~/.config/opencode/opencode.json`); `--project` writes `./opencode.json` in the cwd — matching the `--scope user` vs `--project` semantics of the claude-code path.
- [ ] **D4. Idempotent JSON merge.** Read any existing config, deep-merge only the `mcp.lanework` key (preserving the user's other settings and formatting as best as possible), and create the file/dirs if absent — never clobber an existing config.
- [ ] **D5. Server entry shape.** Register the local stdio server as `{ "type": "local", "command": ["npx","-y","@phake/lanework","mcp"], "enabled": true }`, honoring `--local` (point at this build's `cli.mjs`) and `--no-dashboard` (append `--no-dashboard` to the command) for parity with the claude-code flags.
- [ ] **D6. Refactor `runSetup` to dispatch by client.** Generalize `apps/local/cli.mjs` so `setup <client>` routes to `claude-code` (existing) or `opencode` (new) instead of hard-rejecting any non-`claude-code` client at `cli.mjs:103`; update usage/help strings and the file header comment.
- [ ] **D7. Slash-command parity (yes/no).** Decide whether to also ship the `/lanework:*` commands as OpenCode custom commands (`.opencode/command/*.md`), or keep OpenCode as MCP-tools-only for now (recommended: MCP-tools-only, defer commands).
- [ ] **D8. Docs surfaces.** Add OpenCode to the guide's supported-agents `ToolRow` list and the MCP setup section (`guide.tsx`), the landing brand row (`landing.tsx`), and the README setup block — including the `npx @phake/lanework setup opencode` one-liner.
- [ ] **D9. Brand assets.** Add OpenCode light/dark SVG icons under `components/ui/svgs/` (mirroring `codexLight`/`codexDark`) for the landing/guide rows, or confirm a text-only label is acceptable.
- [ ] **D10. Release hygiene.** Update `CHANGELOG.md` and bump the version (plugin.json / package.json) per the repo's release convention once the integration lands.
