# Version names (INF-10)

The desktop app has two kinds of version: **releases**, which ship, and
**dev builds**, which a maintainer installs locally. You can tell which one is
running from the version alone.

| Kind | Format | Built by | Example |
| --- | --- | --- | --- |
| Release | `X.Y.Z` | `bun run dist`, `mise run app:dmg`, the release workflow | `0.2.0` |
| Preview | `X.Y.Z-preview-YYYYMMDDHHmm` | `bun run package`, `mise run app:package`, `mise run app:install` | `0.1.0-preview-202611121432` |
| Dev (unpackaged) | `X.Y.Z-dev-YYYYMMDDHHmm`, shown only | `mise run dev` | `0.1.0-dev-202611121432` |

## Rules

- **`apps/desktop/package.json` holds the last release version**, and plain
  `X.Y.Z` only: no `-dev`, `-beta` or other suffix. The release workflow
  refuses a tag that does not match it.
- **Only `mise run release:bump <patch|minor|major>` changes it.** It writes
  the new version, commits that file alone as `chore(release): vX.Y.Z` and
  tags `vX.Y.Z`. It does not push; `git push origin HEAD vX.Y.Z` starts the
  release workflow.
  - `patch`: fixes only. `minor`: new features. `major`: breaking changes
    (data or settings that an older build can no longer read).
- **A dev build never writes package.json.** `scripts/electron-builder.mjs
  --dev` stamps the version into the bundle at build time
  (`extraMetadata.version` → `app.getVersion()` and
  `CFBundleShortVersionString`, `buildVersion` → `CFBundleVersion`).
- A Preview names the **release it was built after** (`X.Y.Z` from
  package.json) and the local build time to the minute: `0.1.0-preview-…`.
  It never updates, so where it sorts against releases does not matter; the
  stamp alone tells two Previews apart, with no counter to keep and nothing
  to commit.
- `mise run dev` is unpackaged: `app.getVersion()` stays package.json's, and
  the app SHOWS `X.Y.Z-dev-YYYYMMDDHHmm` (the session's start, from
  `scripts/dev.mjs`) in About, so a report from it is never mistaken for the
  release. Settings → About prefixes every version with `v`.
- `--dev` and `--notarize` are refused together: a dev build is never
  released.

## Preview builds

A dev build is also a different app, so it installs **beside** the release and
neither replaces the other. `scripts/electron-builder.mjs --dev` overrides:

| | Release | Preview (dev build) |
| --- | --- | --- |
| Name (`CFBundleName`, `CFBundleDisplayName`) | `Lanework` | `Lanework (Preview)` |
| Bundle | `Lanework.app` | `Lanework (Preview).app` |
| appId | `com.lanework.desktop` | `com.lanework.desktop.preview` |
| Icon | `build/icon.icns` | `build/icon-preview.icns` (amber PREVIEW band) |
| Data home | `~/.lanew` | `~/.lanew-preview` |
| `userData` | its own | its own, separate from the release's |

- **Both can be installed and run at once.** `mise run app:install` replaces
  only `/Applications/Lanework (Preview).app` and quits only `Lanework
  (Preview)`; it never touches `/Applications/Lanework.app`.
- **No global agent config.** The Preview does not write the user's global
  agent config (`~/.claude.json`, Codex config and the like), so it cannot
  repoint the release's hooks or MCP entry.
- **The icon** is generated: `node apps/desktop/scripts/make-preview-icon.mjs`
  re-marks `build/icon.png` into `build/icon-preview.png` and
  `build/icon-preview.icns` (needs ImageMagick, `sips` and `iconutil`). Run it
  and commit both files when `build/icon.png` changes.
- Release builds (`dist`, `--notarize`) keep the `electron-builder.yml`
  values; only `--dev` overrides them.

## Dev builds never update (INF-11)

The updater (`electron/main/updater/`) is off in any build whose
`app.getVersion()` has a prerelease tag, and in an unpackaged run: it never
checks, downloads or installs, and electron-updater is not even loaded. So a
dev install is never replaced by a release behind your back, and stays on the
build you made until the next `mise run app:install`. Settings → About says so
beside **Check now**. Only a release build (`X.Y.Z`, from the release
workflow) updates, from published GitHub Releases.

## Where it shows

`mise run app:install` prints the installed Preview's version. Finder's Get Info,
`app.getVersion()` and metrics (`v`) all carry the dev version, so a report
from a dev build is never mistaken for one from a release.

## `mise run dev` keeps its own data

An unpackaged dev session (`mise run dev`, `scripts/dev.mjs`) uses
`~/.lanew-dev` as its app home and `~/Library/Application Support/Lanework
(Dev)` as its userData, so it can run beside an open release or Preview
without sharing a database, and a migration in code under way never touches
real data. To work on the real data: `LANEWORK_HOME=~/.lanew mise run dev`.
