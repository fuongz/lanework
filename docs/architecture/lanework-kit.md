# Lanework Kit

How agents search code through the app. For when and how an agent should
call the tools, see [the agents' guide](../agents/lanework-kit.md).

Lanework Kit is `lwk`, a Rust binary from
[lanework-dev/kit](https://github.com/lanework-dev/kit). The app ships a pinned
release of it and runs every search on it (FE-158, FE-161).

## The tools

| Tool | `lwk` | Finds | Engine |
| --- | --- | --- | --- |
| `find_files` | `lwk find` | A file by a half-remembered name, typos allowed | fff-style fuzzy ranking with git signals |
| `search_text` | `lwk grep` | Text, `.gitignore` respected | ripgrep's crates |
| `search_structural` | `lwk sg` | Code by its shape: `useEffect($A, [])` | ast-grep |
| `list_files` | `lwk ls` | The files under a folder | `ignore` walker |
| `search_sessions` | `lwk sessions` | A past Claude Code, Codex or OpenCode chat | transcript reader |

Every call stays inside the folder it starts in: `..`, outward symlinks, `$HOME`
and `/` are refused. The tools' names, inputs and result shapes are the kit's
contract (`contract/kit.json` in the kit repository); the app pins its version.

## How a search travels

```text
 Agent ──MCP──▶ lwk mcp ──────────┐
 Shell ──────▶ lwk grep/find/… ──┤   ask the app first
                                 ▼
                   ~/.lanew/run/kit.sock  (the app; resolves the project's roots)
                                 │
              backend: lwk-shadow (default) · lwk · shadow · ts
                                 │
                                 ▼
                     lwk serve, run by the app  ──▶ answer
                     (the TS kit beside it in shadow modes)

 App not running: lwk answers in-process, from the same engine.
```

- **The MCP server.** Each agent's `lanework-kit` entry runs a shim,
  `~/.lanew/bin/lanework-kit-mcp`, which starts this build's `lwk mcp`. It is on
  by default (Settings → Harness → Lanework Kit). Conversations the app starts
  get the same server, plus a short hint to search with it instead of the
  shell.
- **The socket.** `kit.sock` belongs to the app: it works out the project and
  its folders, then forwards the call.
- **How the app runs `lwk`**, chosen in Settings → Power saver → Search engine
  (lwk): Always running (default), On demand (stops after 5 idle minutes), or
  Per search (nothing resident, with `LWK_NO_SOCKET=1` so it never calls the
  app back).

## Backends and the shadow log

The backend is `LANEWORK_KIT_BACKEND`, else `backend` in `<app home>/kit.json`,
else `lwk-shadow`.

| Backend | Answers | Also runs | Use |
| --- | --- | --- | --- |
| `lwk-shadow` | lwk | the TS kit, compared | Default, until the TS kit is removed (FE-161) |
| `lwk` | lwk | nothing | After the shadow week |
| `shadow` | the TS kit | lwk, compared | Checking lwk before trusting it |
| `ts` | the TS kit | nothing | Falling back |

In the shadow modes every call appends one line to
`<app home>/logs/kit-shadow.jsonl` (rotated at 5 MB): the tool, whether the two
answers match, what differs and how long each took. Differences that are not
errors are tagged: `truncated` (both stopped at the limit and kept different
files), `hidden`, `order`. If lwk is unavailable, the TS answer is served.

## Updating lwk

1. Release a new version of the kit repository.
2. Put its version, contract version and per-target sha256 in
   `apps/desktop/lwk.lock.json`.
3. `bun run gate` fetches it (`scripts/fetch-lwk.mjs`) and checks the versions
   (`scripts/check-lwk-contract.mjs`).

## Where the code is

| Part | Path |
| --- | --- |
| Pin and fetch | `apps/desktop/lwk.lock.json`, `apps/desktop/scripts/fetch-lwk.mjs` |
| Process manager | `apps/desktop/electron/main/lwk-serve.ts` |
| Socket and backends | `apps/desktop/electron/main/kit-socket.ts`, `kit-shadow.ts` |
| MCP entry, shim and hint | `apps/desktop/electron/main/agent-setup/mcp-entry.ts`, `conversation/mcp-args.ts` |
| The TS kit (to be removed) | `apps/desktop/electron/kit/`, `electron/mcp-kit/`, `electron/lwk/`, `apps/desktop/lwk/` |
