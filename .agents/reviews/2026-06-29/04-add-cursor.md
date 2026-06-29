---
status: todo
assignees: ["fuongz"]
created_at: 2026-06-29 00:00:00Z
tags: []
---

# Review: Add cursor

**How to review:** flip `- [ ]` to `- [x]` for each item you agree with; add a `> note` under any you don't. Implementation starts only after every box is `[x]`.

Add a `lanework setup cursor` subcommand to `apps/local/cli.mjs`, mirroring the existing `setup claude-code` flow, so users can register the lanework MCP server with the Cursor editor in one step. Unlike Claude Code there is no `cursor mcp add` CLI, so registration means writing/merging Cursor's `mcp.json` config rather than shelling out.

## Decisions
- [ ] **D1. Scope.** This task = add `lanework setup cursor` (register the MCP server with Cursor), parallel to `setup claude-code` — not broader Cursor integration. The Cursor brand/icon and AGENTS.md guidance already exist; we are only adding the one-command MCP install.
- [ ] **D2. Registration mechanism.** Since Cursor has no `claude mcp add`-style CLI, register by writing/merging a `mcp.json` file: global at `~/.cursor/mcp.json` (default) or project-scoped at `./.cursor/mcp.json` (with `--project`). Approve writing config files instead of spawning a CLI.
- [ ] **D3. Entry format.** Write a `mcpServers` entry of the `command`/`args` form, e.g. `{ "mcpServers": { "lanework": { "command": "npx", "args": ["-y", "@phake/lanework", "mcp"] } } }`; `--local` swaps to `process.execPath` + the absolute `cli.mjs` path, and `--no-dashboard` appends `--no-dashboard` to the args.
- [ ] **D4. Merge, don't clobber.** If `mcp.json` already exists, parse it and merge only the `lanework` key into the existing `mcpServers` object (creating the wrapper if missing), preserving the user's other servers and formatting as much as practical. Never blindly overwrite the file.
- [ ] **D5. Flag parity.** Support the same flags as `setup claude-code`: `--project` (project vs global scope), `--no-dashboard`/`--headless`, `--local`, and `--name <id>` (default `lanework`). Decide whether the Serena-style auto-open-board default also applies to Cursor or whether Cursor should default headless.
- [ ] **D6. CLI routing & help.** Update `runSetup` (currently errors on any client ≠ `claude-code`) to accept `cursor`, and update the usage/`--help` strings in `cli.mjs` to document `lanework setup cursor`.
- [ ] **D7. Success output & errors.** Print the resulting config path and a "restart Cursor, then check Settings → MCP" hint on success; handle missing dir creation, malformed existing JSON, and write-permission failures with clear messages (no silent failure / no fall-through to the dashboard branch).
- [ ] **D8. Docs.** Update the README "Use as an MCP server" note, `apps/local/README.md`, and the guide/landing copy to mention `npx @phake/lanework setup cursor` alongside `setup claude-code`.
- [ ] **D9. Versioning.** Bump `apps/local/package.json` version and add a CHANGELOG entry as a `feat`, consistent with the recent `setup claude-code` release cadence.
