# Contributing

Thanks for helping with Lanework. This repository holds the **desktop app**
and the Claude Code plugin. It is licensed under the
[MIT license](LICENSE); the name and logo are covered by
[TRADEMARKS.md](TRADEMARKS.md).

## What is not here

The control plane — the API (`api.lanework.dev`) and the remote MCP server
(`mcp.lanework.dev`) — is **not** part of this repository and is not open
source. The desktop app talks to it over HTTPS. Issues and pull requests can
only change what lives in this repository.

## Run the desktop app

Use Node.js 24 LTS and **exactly Bun 1.3.11**, the version `packageManager`
in `package.json` pins. The committed plugin bundle is compared byte for byte
with a fresh build, and bun's bundler output changes between releases, so
`build:plugin` and the gate refuse any other bun. With mise:
`mise use bun@1.3.11`.

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev` opens Electron and starts Vite on `http://127.0.0.1:5175`. See
[README.md](README.md) for the rest of the commands and the folder layout.

By default the app signs in against `https://api.lanework.dev`. To point it at
another control plane (a local stub, a `wrangler dev`, your own deployment),
set `LANEWORK_API_URL`:

```sh
LANEWORK_API_URL=http://127.0.0.1:8787 bun run dev
```

## Before you open a pull request

```sh
bun run gate:public
```

It builds the desktop app, runs Biome (a warning fails it) and the layout,
loading-state and HTML-sink audits, typechecks it, and checks that the
committed plugin bundle is current (`bun run build:plugin` rebuilds it). It
needs nothing from the backend.

The same command runs on every pull request (`.github/workflows/gate.yml`),
together with a gitleaks scan of the full history and a `bun audit` that fails
only on a critical or high advisory in a package the app ships. CI runs no
tests. The Electron-free unit tests run with `bun run test:unit`, the
Playwright suite with `bun run test` after `bun run build`.

Changes under `plugins/lanework/`, `.claude/` and
`apps/desktop/electron/hook/` run on other people's machines once merged, so
they need the code owner's review (`.github/CODEOWNERS`).

Format only the files you changed (`bunx biome check --write <files>`), not
the whole repository. Use [Conventional Commits](https://www.conventionalcommits.org/)
for commit messages, e.g. `fix(desktop): reject untrusted senders`.

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote
the change, or have the right to submit it under the MIT license.

```sh
git commit -s -m "fix(desktop): ..."
```

`-s` adds `Signed-off-by: Your Name <you@example.com>` from your git config.
Pull requests with unsigned commits cannot be merged; fix them with
`git rebase --signoff <base>`.
