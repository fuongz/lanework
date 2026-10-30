# Lanework desktop

Electron desktop starter with TanStack Start, React, Zustand and shadcn/ui.
UI preset: **`b1D0eCA6`**, Base UI / Mira, neutral, Inter, Hugeicons, with
**`--pointer`** enabled. Fonts and assets ship locally.

## Run

Use Node.js 24 LTS and exactly Bun 1.4.4, the version `packageManager` pins
(see [CONTRIBUTING.md](CONTRIBUTING.md)).

```sh
bun install --frozen-lockfile
bun run dev
```

The command opens Electron and starts Vite at **http://127.0.0.1:5175**.
The port is strict: an occupied port produces an error instead of silently
changing the Electron renderer origin.

- React and CSS changes use Vite HMR / React Fast Refresh.
- Main, preload and their imported contracts rebuild with esbuild and restart
  Electron. Native-process state resets on restart.
- `Ctrl+C` stops Electron, Vite and the watcher.
- `bun run --cwd apps/desktop dev:renderer` previews the UI in a browser. Native
  app information is available only inside Electron.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Desktop development with HMR on port 5175 |
| `bun run build` | Build the SPA shell, assets, main and preload |
| `bun run typecheck` | Check renderer and Electron TypeScript separately |
| `bun run lint` | Biome (a warning fails) and the layout, loading-state and HTML-sink audits |
| `bun run format` | Apply formatting and safe lint fixes |
| `bun run gate` | Build → Electron bundle audit → lint → typecheck → plugin bundle check |
| `bun run test` | Playwright specs against the production build |
| `bun run test:unit` | Electron-free `*.test.ts` units under `apps/desktop/electron` |
| `bun run test:packaged` | Smoke-test the unpacked macOS app (run package first) |
| `bun run test:dev` | Verify UI HMR and main/preload restart |
| `bun run package` | Build an unpacked desktop application for the host OS |
| `bun run --cwd apps/desktop dist` | Build an installer for the host OS |

Run `build` before `typecheck` or `test` on a fresh checkout: TanStack generates
`src/routeTree.gen.ts`, and Electron tests load the production build.
The development test briefly edits and restores three source files; run it
without another dev server or simultaneous edits to those files.

Output lives in `apps/desktop/dist/` and `apps/desktop/release/`.
On Apple Silicon the unpacked app is typically
`apps/desktop/release/mac-arm64/Lanework.app`.

## Folder structure

```text
apps/desktop/
├── electron/
│   ├── main/                # Electron main process
│   │   ├── index.ts         # App/window lifecycle, CSP, permissions, registers every feature
│   │   ├── menu.ts          # Application menu
│   │   ├── ipc.ts           # handle(): sender-checked IPC registration
│   │   ├── ipc-args.ts      # Typed IPC argument checks
│   │   ├── protocol.ts      # app:// static assets and SPA fallback
│   │   ├── security.ts      # Origin and asset-path validation
│   │   ├── paths.ts         # The app home (~/.lanew or LANEWORK_HOME)
│   │   ├── config-file.ts   # Atomic writes to other tools' config files
│   │   ├── http-body.ts     # Size-capped response bodies
│   │   ├── auth/, projects/, git/, terminal/, conversation/, …
│   │   │                    # One folder per feature; index.ts registers its IPC
│   │   └── terminal/host.ts # The pty host, a separate utility process
│   ├── preload/index.ts     # contextBridge: one typed window.desktop
│   ├── hook/                # Agents' Stop hook (plain Node, also the plugin's source)
│   ├── mcp-local/           # Offline MCP server (plain Node)
│   ├── local-store/         # SQLite store for local boards
│   ├── control/             # lanework-control, the orchestration lead's CLI
│   └── statusline/          # Claude Code status line script
├── shared/                  # Contracts, channel names, pure functions (main + renderer)
├── src/
│   ├── routes/              # URL declarations; export Route only
│   ├── components/
│   │   ├── ui/              # shadcn CLI-owned components
│   │   ├── shared/          # Components with 2+ importers, grouped by domain
│   │   └── features/        # Single-consumer views, grouped by feature
│   ├── hooks/               # Hooks used across feature areas
│   ├── stores/              # Zustand stores and selectors
│   ├── server/desktop.ts    # The renderer's seam in front of window.desktop
│   ├── lib/                 # Framework-free utilities
│   └── styles/app.css       # Preset tokens, font and Tailwind sources
├── native/dictation/        # Swift dictation helper (macOS)
├── scripts/                 # Build, bundle and dev orchestration
├── tests/                   # Playwright specs that boot the app
├── build/                   # Icons and macOS entitlements
└── electron-builder.yml     # Packaging, fuses and asar unpacking
packages/protocol/           # @lanework/protocol: types shared with the control plane
plugins/lanework/            # Claude Code plugin; bin/ holds the committed hook bundle
scripts/                     # Gate audits and the plugin build
docs/standards/              # Layout, loading-state and process-boundary standards
```

Every desktop rule, and the gate that enforces it, is indexed in
[apps/desktop/AGENTS.md](apps/desktop/AGENTS.md). The renderer layout is
[the layout standard](docs/standards/frontend-app-layout.md); what each process
may import is [the process-boundaries standard](docs/standards/process-boundaries.md).

## Runtime boundaries

The React package for TanStack Start is **`@tanstack/react-start`**.
Its Vite plugin builds an SPA shell. Electron serves only `dist/client` over
`app://lanework`, including a fallback for route reloads. The generated
`dist/server` is used at build time for prerendering and is not packaged.
There is no production localhost HTTP server, SSR service or server function
endpoint. Native operations belong in main-process IPC handlers.

Electron enables `sandbox`, `contextIsolation` and `webSecurity`, with
`nodeIntegration` disabled. Preload bundles to CommonJS for the sandbox and
exposes one typed object, `window.desktop` (`DesktopApi` in
`shared/desktop.ts`), with one surface per domain. Every IPC handler checks
its sender with `assertTrustedSender()` (`electron/main/ipc.ts`), almost always
through `handle()`: only the top frame of an app window on a trusted origin
is accepted. New windows, off-origin navigation and permission
requests are denied. The custom protocol rejects path traversal and missing
assets; missing routes receive the shell. CSP permits the exact hashes of
Start's inline bootstrap scripts; inline styles remain enabled for UI
components.

Besides main, preload and the renderer, the build has outputs that run
elsewhere: the pty host (a utility process), and the Stop hook, status line,
offline MCP server and `lanework-control`, which the agents' configs run under
the app's plain Node (`ELECTRON_RUN_AS_NODE`). Those never import `electron`,
and `scripts/audit-electron.mjs` checks what each bundle really contains.

The app ships no runtime `dependencies`: main, preload and renderer are
bundled, and node-pty, the one module main loads unbundled, is staged into
`dist/` by `scripts/electron-bundle.mjs`. Packaged builds flip Electron fuses
(no `NODE_OPTIONS`, no `--inspect`, asar integrity, app only from asar); see
`electron-builder.yml`.

## Adding code

- Renderer modules must not import Electron, Node builtins or main/preload
  code; Biome fails the gate if they do.
- A native action: add its channel to the domain's `<domain>Channels` in
  `shared/<domain>.ts` and its method to that domain's surface on
  `DesktopApi`, implement it in preload, and register the handler with
  `handle()` in `electron/main/<domain>/index.ts`, checking the payload
  (`ipc-args.ts`). A new domain registers from `electron/main/index.ts`. The
  renderer calls it through `desktopSurface()` in `src/server/desktop.ts`.
- Other features import a feature's named service files, not its `index.ts`.
- Keep feature state local until it needs to outlive a component. Use Zustand
  selectors instead of subscribing to an entire store.
- Use the `#/` alias, declared in package imports and mirrored in TypeScript.
- Add primitives with the registry CLI rather than hand-writing `components/ui`:

  ```sh
  cd apps/desktop
  bunx --bun shadcn@latest add dialog
  ```

The registry currently imports `cn` from its own package. The app's `lib/utils`
re-exports it for handwritten code. Root Biome exceptions are scoped to upstream
Field/Label/InputGroup wrappers whose ARIA props and error-list rendering are
intentional.

## Verification and distribution

`bun run gate` runs on every pull request (`.github/workflows/gate.yml`), with
a gitleaks scan and a `bun audit` of shipped packages. CI runs no tests.
Electron-free units are colocated `*.test.ts` files (`bun run test:unit`);
Playwright specs in `apps/desktop/tests/` boot the built app
(`bun run test`, after `bun run build`). Test artifacts are stored in
`.agents/artifacts/`.

Only macOS Apple Silicon is verified. The macOS build is ad hoc signed, not
notarized, with explicit entitlements (`build/entitlements.mac*.plist`); each
DMG gets a `.sha256` next to it. Automatic updates are not configured. Local
packaging is intended for development, not a signed public release.

Windows (`nsis`) and Linux (`AppImage`) targets are configured but must not
ship until these are fixed:

- **SX-02 (Windows):** `git` and `gh` are looked up by name with the
  repository as `cwd`, so a `git.exe` or `gh.exe` committed to a repo would
  run (`electron/main/git/runner.ts`, `git/gh.ts`).
- **SW-02 (Windows):** "Open in Default App" refuses a denylist of launchable
  extensions (`LAUNCHABLE` in `shared/worktree.ts`) that misses Windows
  script-host, shortcut and HTML-application types, and the exec-bit check
  does nothing there.
- **GAP-02 (Linux AppImage):** an AppImage runs from a temporary mount, so it
  refuses to install the agent hook and offline MCP shims
  (`shimRefusal` in `electron/main/agent-setup/mcp-entry.ts`); those features
  need a non-AppImage Linux target.
- **SW-07 (Windows, Linux):** there is no single-instance lock, so a second
  launch runs a second main process over the same `~/.lanew` state.

## Sources and design decisions

There is no single official Electron folder standard. This layout combines
process boundaries recommended by Electron with a feature-oriented renderer:

- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-vite project structure](https://electron-vite.org/guide/dev)
- [Electron custom protocol](https://www.electronjs.org/docs/latest/api/protocol)
- [TanStack Start SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode)
- [TanStack hydration guidance](https://tanstack.com/start/latest/docs/framework/react/guide/hydration-errors)
- [shadcn preset](https://ui.shadcn.com/create?preset=b1D0eCA6)
- [shadcn CLI](https://ui.shadcn.com/docs/cli)
- [Zustand persistence](https://zustand.docs.pmnd.rs/integrations/persisting-store-data)

The project borrows electron-vite's separation of processes; it uses separate
Vite/Start and esbuild pipelines so Start owns its renderer build lifecycle.
