# Desktop coding conventions

The index of every desktop rule: one line each, the gate that enforces it, and
where the details live. Follow the repository root AGENTS.md for planning,
review cards and commits.

`bun run gate` (root) runs, in order: `build`, `scripts/audit-electron.mjs`,
`lint` (Biome with `--error-on-warnings`, then `audit-layout.mjs`,
`audit-loading.mjs`, `audit-sinks.mjs`), `typecheck` and
`build-plugin.mjs --check`. CI runs the same command
(`.github/workflows/gate.yml`).

Details: [process boundaries](../../docs/standards/process-boundaries.md),
[frontend app layout](../../docs/standards/frontend-app-layout.md),
[loading states](../../docs/standards/loading-states.md).

## Processes

| Rule | Gate | Details |
| --- | --- | --- |
| Renderer (`src/`) and `shared/` never import a Node built-in or `electron`; the renderer reaches main through `window.desktop` via `src/server/desktop.ts`. | Biome | [What each side may import](../../docs/standards/process-boundaries.md#what-each-side-may-import) |
| Preload exposes one typed `DesktopApi`; never raw `ipcRenderer`, filesystem access or arbitrary channel names. | Not gated | [What each side may import](../../docs/standards/process-boundaries.md#what-each-side-may-import) |
| Every main handler checks its sender through `handle()` (`electron/main/ipc.ts`), or `assertTrustedSender()` when it needs the event; payloads are checked in main, with `ipc-args.ts` where adopted. | Not gated | [What each side may import](../../docs/standards/process-boundaries.md#what-each-side-may-import) |
| Main bundles no node-pty, xterm, hook or offline-MCP code (except `hook/redact.ts`); only `git/runner.ts` runs `git`; no hand-built `/v1` paths. | `audit-electron.mjs` | [What each side may import](../../docs/standards/process-boundaries.md#what-each-side-may-import) |
| `electron/hook/`, `mcp-local/`, `local-store/`, `statusline/`, `control/` and `shared/` never import `electron`. | `audit-electron.mjs` | [The outputs](../../docs/standards/process-boundaries.md#the-outputs) |
| `shared/` is contracts, constants and pure deterministic functions: no I/O, no platform API, no module-level mutable state; runtime deps are `@lanework/protocol` and `smol-toml`. The Codex model registry is the named exception. | Biome (imports only) | [`shared/`](../../docs/standards/process-boundaries.md#shared) |
| A main feature's `index.ts` is imported only by `main/index.ts` and `menu.ts`; other features import its named service files. Current exceptions are listed with what removes each. | Not gated | [Main-process features](../../docs/standards/process-boundaries.md#main-process-features) |

## Auth and app home

| Rule | Gate | Details |
| --- | --- | --- |
| The credential lives only in main (`electron/main/auth/`); the renderer gets a redacted session. Only `auth/store.ts` and `auth/index.ts` import Electron. | Not gated | [What each side may import](../../docs/standards/process-boundaries.md#what-each-side-may-import) |
| `shared/policy.ts` `can()` is the authorization rule. Main enforces it on cloud and credential operations; local surfaces (terminal, conversation, worktree, agent-config, dictation, local boards) are intentionally not session-gated. The renderer calls it only to hide what would be refused. | Not gated | [Authorization](../../docs/standards/process-boundaries.md#authorization) |
| The app home is named once, in `electron/main/paths.ts` (`~/.lanew`, overridden by `LANEWORK_HOME`). | Not gated | `paths.ts` |
| A config file another tool owns is written through `electron/main/config-file.ts` (atomic, keeps mode and symlinks). | Not gated | `config-file.ts` |

## Renderer

| Rule | Gate | Details |
| --- | --- | --- |
| `components/ui/` belongs to the shadcn CLI (preset `b1D0eCA6` with `--pointer`); compose in `features/<domain>/` for one importer, `shared/<domain>/` for two or more. | `audit-layout.mjs` | [Rule A](../../docs/standards/frontend-app-layout.md#3--rule-a--components-splits-by-reuse-count), [vendored territory](../../docs/standards/frontend-app-layout.md#9--vendored-territory) |
| `hooks/` holds `use-<kebab>.ts` hooks used by two or more areas; others stay beside their feature. | `audit-layout.mjs` | [Rule B](../../docs/standards/frontend-app-layout.md#4--rule-b--hooks-is-for-hooks-that-cross-domains) |
| Routes export only `Route`; views live in components, UI stores in `stores/`. | `audit-layout.mjs` | [Rule C](../../docs/standards/frontend-app-layout.md#5--rule-c--a-route-declares-a-url-and-nothing-else) |
| `lib/` is framework-free: no `.tsx`, no runtime React, TanStack or Node import. | `audit-layout.mjs` | [Rule E](../../docs/standards/frontend-app-layout.md#7--rule-e--lib-is-the-floor) |
| Layers import one way: `routes` → `components` → `hooks` → `stores` → `server` → `content` → `lib`. | `audit-layout.mjs` | [Rule F](../../docs/standards/frontend-app-layout.md#8--rule-f--dependencies-point-one-way) |
| A pane, list, panel or value still being read draws a skeleton (`components/shared/loading/skeletons.tsx`), never a "Loading…" sentence; button labels are the exception. | `audit-loading.mjs` | [loading-states.md](../../docs/standards/loading-states.md) |
| Renderer code never writes markup through `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `dangerouslySetInnerHTML`. | `audit-sinks.mjs`, Biome | `scripts/audit-sinks.mjs` |
| Kebab-case file names, explicit imports and the `#/` alias; generated files and registry components keep upstream names. | Not gated (hook names: `audit-layout.mjs`) | [Naming](../../docs/standards/frontend-app-layout.md#10--naming) |

## Runtime and build

| Rule | Gate | Details |
| --- | --- | --- |
| Production is a static Start SPA over `app://lanework`; no server functions without a reviewed design. | Not gated | [README](../../README.md#runtime-boundaries) |
| Dev uses port 5175; change Vite, Electron's origin check and the dev launcher together. | Not gated | [README](../../README.md#run) |
| TypeScript is strict (`tsconfig.base.json`); renderer and Electron typecheck separately. | `typecheck` | `tsconfig.json`, `tsconfig.node.json` |
| The committed plugin bundle matches a fresh build on Bun 1.3.11. | `build-plugin.mjs --check` | Root AGENTS.md |
| Never commit generated route trees, build output, test profiles or installers. | Not gated | — |

## Tests

| Rule | Gate | Details |
| --- | --- | --- |
| An Electron-free unit is a colocated `*.test.ts` (`node:test`), run by `bun run test:unit`; anything that boots the app is a `tests/*.spec.ts`, run by `bun run test` after `bun run build`. | Not gated (CI runs no tests) | [Tests](../../docs/standards/process-boundaries.md#tests) |
| A spec that boots the app sets `LANEWORK_HOME`; `LANEWORK_TEST_USER_DATA` moves only Electron's `userData`. | Not gated | [Tests](../../docs/standards/process-boundaries.md#tests) |
| Watcher/HMR changes run `bun run test:dev`, without another dev server. | Not gated | [README](../../README.md#commands) |
