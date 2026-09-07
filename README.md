# Lanework desktop

Electron desktop starter with TanStack Start, React, Zustand and shadcn/ui.
UI preset: **`b1D0eCA6`**, Base UI / Mira, neutral, Inter, Hugeicons, with
**`--pointer`** enabled. Fonts and assets ship locally.

## Run

Use Node.js 24 LTS and Bun 1.3.11 or newer.

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
| `bun run lint` | Biome and frontend layout audit |
| `bun run format` | Apply formatting and safe lint fixes |
| `bun run gate` | Build → lint/layout → typecheck |
| `bun run test` | Production Electron smoke test and security unit tests |
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
│   ├── main/
│   │   ├── index.ts         # App/window lifecycle, permissions, IPC handlers
│   │   ├── protocol.ts      # app:// static assets and SPA fallback
│   │   └── security.ts      # Origin and asset-path validation
│   └── preload/index.ts    # Narrow contextBridge API
├── shared/desktop.ts       # IPC channel names and serializable contracts
├── src/
│   ├── routes/             # URL declarations; export Route only
│   ├── components/
│   │   ├── ui/             # shadcn CLI-owned components
│   │   ├── shared/         # Components with 2+ importers, grouped by domain
│   │   └── features/       # Single-consumer views, grouped by feature
│   ├── stores/             # Zustand UI preferences and selectors
│   ├── hooks/              # Hooks used across feature areas
│   ├── lib/                # Pure, platform-independent utilities
│   ├── styles/app.css      # Preset tokens, font and Tailwind sources
│   └── router.tsx          # TanStack router configuration
├── scripts/                # Build and development process orchestration
├── tests/                  # Desktop, security and HMR verification
├── vite.config.ts          # TanStack Start SPA pipeline
├── tsconfig.json           # Renderer TypeScript
├── tsconfig.node.json      # Main/preload and test TypeScript
└── electron-builder.yml    # Packaging configuration
```

Root-level `scripts/audit-layout.mjs` checks the renderer conventions described
in [the layout standard](docs/standards/frontend-app-layout.md). Empty feature
layers are placeholders, not a requirement to add unused abstractions.

## Runtime boundaries

The React package for TanStack Start is **`@tanstack/react-start`**.
Its Vite plugin builds an SPA shell. Electron serves only `dist/client` over
`app://lanework`, including a fallback for route reloads. The generated
`dist/server` is used at build time for prerendering and is not packaged.
There is no production localhost HTTP server, SSR service or server function
endpoint. Native operations belong in main-process IPC handlers.

The root uses `ClientOnly` so the same prerendered shell can open any desktop
route without hydrating navigation or persisted preferences against the wrong
initial page. Zustand persists only the compact-layout preference and rehydrates
after mounting. Native app information is fetched through the preload API and
kept in the Settings view, rather than copied into a global store.

Electron enables `sandbox`, `contextIsolation` and `webSecurity`, with
`nodeIntegration` disabled. Preload bundles to CommonJS for the sandbox and
exposes only `desktop.getAppInfo()`. IPC validates the owning top frame, origin
and argument count. New windows, off-origin navigation and permission requests
are denied. The custom protocol rejects path traversal and missing assets;
missing routes receive the shell. CSP permits the exact hashes of Start's
inline bootstrap scripts; inline styles remain enabled for UI components.

All current app dependencies are build-time dependencies because main/preload
and renderer code are bundled. If a future native Node module must remain
external, put it in `dependencies`, externalize it in the Electron build and
verify its packaged binary for each supported architecture.

## Adding code

- Renderer modules must not import Electron, Node builtins or main/preload code.
- Add native actions to `shared/desktop.ts`, expose one method per action from
  preload, and validate both sender and payload in main.
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
Field/Label wrappers whose ARIA props and error-list rendering are intentional.

## Verification and distribution

The production smoke test opens the built Electron application, calls IPC,
changes a preference, reloads `/settings`, then closes and reopens the app to
verify persistence. Security tests cover origins and traversal paths. The
development test proves that UI updates preserve the page and native-source
edits restart Electron. Test artifacts are stored in `.agents/artifacts/`.

The initial scaffold is verified on macOS Apple Silicon. Windows and Linux
targets are configured but require testing on those platforms. Signing,
notarization, custom application icons and automatic updates are not configured.
Local packaging is intended for development, not a signed public release.

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
