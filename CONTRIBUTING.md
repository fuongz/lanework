# Contributing

Thanks for helping with Lanework. This repository holds the **desktop app**,
the landing page and the Claude Code plugin. It is licensed under the
[MIT license](LICENSE); the name and logo are covered by
[TRADEMARKS.md](TRADEMARKS.md).

## What is not here

The control plane — the API (`api.lanework.dev`) and the remote MCP server
(`mcp.lanework.dev`) — is **not** part of this repository and is not open
source. The desktop app talks to it over HTTPS. Issues and pull requests can
only change what lives in this repository.

## Run the desktop app

Use Node.js 24 LTS and Bun 1.3.11 or newer.

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

It builds the desktop app and the landing page, runs Biome and the layout
audit, typechecks both, and checks that the committed plugin bundle is current
(`bun run build:plugin` rebuilds it). It needs nothing from the backend.

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
