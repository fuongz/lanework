# How Lanework works

One page to find your way around. Details live in the pages it links to.

## The pieces

```text
            You                         Coding agents (CLIs you installed)
             │                       Claude Code · Codex · OpenCode
             ▼                                   ▲   │ MCP + hooks
   ┌─────────────────────┐   spawns, streams     │   ▼
   │  Lanework desktop   │ ──────────────────────┘  ┌──────────────────────┐
   │  (Electron)         │                          │ lanework       board │
   │                     │◀── ~/.lanew/run/kit.sock │ lanework-kit  search │
   │  main ◀─ IPC ─▶ UI  │                          │ lanework_control     │
   └─────────┬───────────┘                          │        (conductors)  │
             │                                      └──────────────────────┘
     ┌───────┴────────────────┐
     ▼                        ▼
 Local board              Cloud board
 SQLite in ~/.lanew       api.lanework.dev, mcp.lanework.dev
                          (not in this repository)
```

- **The app** runs the agents you already use. It does not sell tokens or call
  a model itself: a conversation is a CLI process (`claude`, `codex app-server`,
  `opencode`) that the app starts, feeds and reads.
- **The board** holds the work as cards. It lives on this machine (local mode,
  a SQLite file in `~/.lanew`) or in the cloud once you sign in. Both speak the
  same contract, `@lanework/contracts`.
- **Agents reach Lanework through MCP servers** the app hands to the processes
  it starts, and through the entries it writes into each agent's own config:
  - `lanework`: the board's tools (list, create and tick cards, checkpoint).
  - `lanework-kit`: fast search (files, text, code shape, past chats), served
    by `lwk`. See [Lanework Kit](lanework-kit.md).
  - `lanework_control`: only for a conductor, to start sessions and runs.
- **A Stop hook** leaves a checkpoint on the card after every agent turn, so
  another agent can resume it. See [the checkpoint hook](../agents/checkpoint-hook.md).

## The desktop app's processes

| Process | Code | Does |
| --- | --- | --- |
| Main | `apps/desktop/electron/main/` | Windows, IPC, agents, git, terminals, the board's local store, updates. One folder per feature; its `index.ts` registers its IPC. |
| Preload | `apps/desktop/electron/preload/` | The one typed `window.desktop` bridge. |
| Renderer | `apps/desktop/src/` | The UI: a TanStack Start SPA with React, Zustand and shadcn/ui, served over `app://lanework`. |
| Shared | `apps/desktop/shared/` | Types, channel names and pure functions both sides import. |
| Plain Node | `electron/hook`, `electron/mcp-local`, `electron/mcp-control`, `electron/control` | Run outside Electron: the checkpoint hook, the local board's MCP server, the conductor tools. |
| Native | `lwk` (fetched release), `lanework-dictation` (Swift), the pty host | Search, dictation and terminals. |

What each process may import is a gated rule: [process boundaries](../standards/process-boundaries.md).
Where files go in the renderer: [frontend app layout](../standards/frontend-app-layout.md).

## Where data lives

| Path | Holds |
| --- | --- |
| `~/.lanew/` | The app home: local boards (`data.sqlite`), `bin/` shims for agents, `run/kit.sock`, logs. The Preview uses `~/.lanew-preview`, a dev run `~/.lanew-dev`. |
| `~/Library/Application Support/Lanework/` | Electron's own data: settings such as Power saver. |
| Each agent's config | `~/.claude.json`, `~/.codex/config.toml`, `opencode.json`: the app adds only its own `lanework` and `lanework-kit` entries and hooks. |

## Release channels

The release app, the Preview (`Lanework (Preview).app`) and a dev run install
side by side, each with its own data home. Only the release app writes the
agents' global config. See [releasing](../releasing.md).

## Read next

- New here: [development](../development.md) to build and run it.
- Working on a feature: [Lanework Kit](lanework-kit.md), [dictation](dictation.md).
- An agent working in this repo: [AGENTS.md](../../AGENTS.md), then [docs/agents](../agents/).
