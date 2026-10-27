# Process boundaries in the desktop app

Where code may run in `apps/desktop`, what it may import, and who checks it.
The renderer's own file layout is in
[frontend-app-layout.md](frontend-app-layout.md); the one-line index of every
desktop rule is [apps/desktop/AGENTS.md](../../apps/desktop/AGENTS.md).

## The outputs

`scripts/electron-bundle.mjs` builds one bundle per entry. Each runs somewhere
different, so each has different imports available.

| Source | Output | Runs in |
| --- | --- | --- |
| `electron/main/index.ts` | `main/index.cjs` | Electron main |
| `electron/main/terminal/host.ts` | `main/pty-host.cjs` | Utility process (`utilityProcess.fork`), owns node-pty |
| `electron/preload/index.ts` | `preload/index.cjs` | Sandboxed preload |
| `src/` | `dist/client` | Sandboxed renderer over `app://lanework` |
| `electron/hook/lanework-checkpoint.ts` | `hook/lanework-checkpoint.cjs` | Plain Node (`ELECTRON_RUN_AS_NODE`), the agents' Stop hook |
| `electron/statusline/claude-usage.ts` | `statusline/claude-usage.cjs` | Plain Node, Claude Code's status line |
| `electron/mcp-local/main.ts` | `mcp-local/server.cjs` | Plain Node, the offline MCP server |
| `electron/control/main.ts` | `control/lanework-control.cjs` | Plain Node, the lead's control CLI |

The plain-Node outputs cannot `require("electron")`, and they are unpacked
from the asar (`electron-builder.yml` `asarUnpack`).

## What each side may import

- **Renderer (`src/`)** reaches main only through `window.desktop`, via the
  seam in `src/server/desktop.ts` (`desktopSurface(key)`). No Node built-in,
  no `electron`, no `electron/` file. Gate: Biome (`noNodejsModules`,
  `noRestrictedImports` on `src/**` and `shared/**`).
- **Preload (`electron/preload/`)** exposes one typed object, `DesktopApi`
  from `shared/desktop.ts`, with one surface per domain. Never raw
  `ipcRenderer`, filesystem access or a caller-chosen channel name. Not gated.
- **Main (`electron/main/`)** owns native capabilities. Every `invoke` handler
  checks its sender with `assertTrustedSender()` in `ipc.ts`, which rejects
  anything but the top frame of an app window on a trusted URL. `handle()`
  applies it for you; the one handler that needs the raw event (terminal's
  `connect`) calls it directly. Payloads are checked
  in main: `ipc-args.ts` (`arity`, `id`, `slug`, `int`, `oneOf`) is adopted one
  handler file at a time. Sender check: by construction (`handle()`); payload
  checks: not gated.
- **Main never bundles** node-pty, xterm, the Stop hook (apart from
  `hook/redact.ts`) or the offline MCP server; only `git/runner.ts` runs
  `git`; `workspaces/client.ts` never builds a `/v1` path by hand. Gate:
  `scripts/audit-electron.mjs`, which reads the build's metafile.
- **Electron-free folders**: `electron/hook/`, `electron/mcp-local/`,
  `electron/local-store/`, `electron/statusline/`, `electron/control/` and
  `shared/` never import `electron`. In `electron/main/auth/`, only `store.ts`
  and `index.ts` do. Gate: `audit-electron.mjs` for the folders; the auth rule
  is not gated.

## `shared/`

`shared/` holds contracts, constants and pure deterministic functions that
both main and the renderer import: channel names (`<domain>Channels`),
payload types, validators, parsers.

- No I/O, no platform API, no module-level mutable state.
- Runtime dependencies: `@lanework/protocol` and `smol-toml` (used by
  `agent-config-text.ts`). Nothing else.
- **Named exception: the Codex model registry** in `shared/conversation.ts`
  (`setCodexModels` and its listeners). Main and the renderer each hold their
  own copy, filled from Codex's cache; anything that validates a Codex model
  depends on `setCodexModels` having run in that process first.

Gate: Biome bans Node built-ins and `electron` here, and `audit-electron.mjs`
lists `shared/` as Electron-free. The I/O, state and dependency rules are not
gated.

## Authorization

`shared/policy.ts` `can()` is the one rule; `lockState()` derives the lock
screen from it, so the renderer and main read the same answer.

- **Main enforces `can()` on cloud and credential operations.** `auth/index.ts`
  checks it to sign in, sign out and revoke this machine.
  `workspaces/session.ts` `authorizedRecord()` checks `cloud:use` before any
  control-plane call made with the machine credential, and
  `assertCanUse()` there admits a local-mode session too. The terminal and
  workspace handlers reach the cloud through these two.
- **Local surfaces are intentionally not session-gated**: terminal,
  conversation, worktree, agent-config, dictation and local boards. They act
  on the user's own files as the same local user, so a lock screen in front of
  them is UI, not a boundary.
- The renderer may call `can()` only to hide what main would refuse.
- Known gap: `handoff/index.ts` decides from the machine record on disk
  (`readRecord()`), not from `can()`.

Not gated.

## Main-process features

A feature lives in `electron/main/<feature>/`. Its `index.ts` registers the
IPC handlers (`register<Feature>(devUrl)`) and is imported only by
`electron/main/index.ts` and `electron/main/menu.ts`. Another feature imports
the named service file it needs (`workspaces/session.ts`, `git/runner.ts`),
never the `index.ts`, so it does not pull in the first feature's IPC module
and Electron with it.

Current exceptions, each with what removes it:

| `index.ts` | Imported by | Goes away when |
| --- | --- | --- |
| `workspaces` (re-exports `session.ts`) | agent-setup, conversation, git, instructions, memory, orchestration, readiness, terminal | Those import `workspaces/session.ts` and the re-export is dropped |
| `auth` (`currentSession`) | agent-setup, `workspaces/session.ts` | `currentSession` moves to its own auth service file |
| `handoff` (`forgetHookCredential`, `forgetBoardsCache`, `syncHandoff`) | auth | Those move to a handoff service file |
| `terminal` (`onRunningChanged`, `runningProjects`, `sendTerminalCommand`) | menu-bar | The running-project registry moves out of `index.ts` |
| `orchestration` (`workerFolderOf`) | conversation | `workerFolderOf` moves to an orchestration service file |

Shared main-process helpers sit at the top of `electron/main/`: `ipc.ts`,
`ipc-args.ts`, `paths.ts` (the app home, `~/.lanew` or `LANEWORK_HOME`),
`agent-home.ts`, `config-file.ts` (atomic config writes), `http-body.ts`
(capped response bodies), `frontmatter.ts` and `test-seams.ts`.

Not gated.

## Tests

- An **Electron-free unit** is a colocated `*.test.ts` beside the file it
  tests, written against `node:test` and `node:assert` and run by
  `bun run test:unit` (`scripts/test-unit.mjs`, one `bun test` per file).
- Anything that **boots the app** is a Playwright spec in
  `apps/desktop/tests/*.spec.ts`, run by `bun run test` after
  `bun run build`. A spec that boots the app sets `LANEWORK_HOME`.

CI runs neither; see the root AGENTS.md for when tests run.
