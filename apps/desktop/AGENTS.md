# Desktop coding conventions

Follow the repository root AGENTS.md for planning and review-card lifecycle.

- Renderer: `src/`. Never import Node, Electron, main or preload modules here.
- Main: `electron/main/`. Own native capabilities, validate every IPC sender
  and payload, and keep window lifecycle separate from feature services.
- Preload: `electron/preload/`. Expose a narrow typed API with contextBridge;
  never expose raw ipcRenderer, filesystem access or arbitrary channel names.
- Shared: `shared/`. Serializable contracts and constants only; no platform APIs.
- Auth: the credential lives only in main (`electron/main/auth/`). The renderer
  receives a redacted session and never a secret; `store.ts` and `auth/index.ts`
  are the only auth modules allowed to import Electron, so the rest stays
  testable without booting the app.
- Authorization is `shared/policy.ts` `can()`. Main enforces it on every gated
  operation; the renderer may call it only to hide what would be refused.
- The app home folder is named once, in `electron/main/paths.ts` (`~/.lanew`,
  overridden by `LANEWORK_HOME`). Nothing else hardcodes it, and every test that
  boots the app must set `LANEWORK_HOME` — `LANEWORK_TEST_USER_DATA` moves only
  Electron's `userData` and will not keep a run out of the real credential.
- UI preset is `b1D0eCA6` with `--pointer`. Use shadcn registry components.
- `src/components/ui/` belongs to the CLI. Compose in `features/<domain>/`
  for one importer, promote to `shared/<domain>/` for two or more.
- Routes export only `Route`. Put views in components and UI stores in `stores/`.
- `lib/` stays framework-free. Hooks belong beside their feature until reused.
- Use kebab-case names, explicit imports and the `#/` alias. Generated filenames
  and registry components retain upstream names.
- Production is a static Start SPA over `app://lanework`; do not add server
  functions without explicitly designing and reviewing their runtime.
- Dev uses port 5175. Update Vite, Electron's origin validation and the dev
  launcher together when changing it.
- Run `bun run gate` and `bun run test` from the root for runtime changes.
  Run `bun run test:dev` for watcher/HMR changes, without another dev server.
- Do not commit generated route trees, build output, test profiles or installers.
