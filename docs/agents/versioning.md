# Version names (INF-10)

The desktop app has two kinds of version: **releases**, which ship, and
**dev builds**, which a maintainer installs locally. You can tell which one is
running from the version alone.

| Kind | Format | Built by | Example |
| --- | --- | --- | --- |
| Release | `X.Y.Z` | `bun run dist`, `mise run app:dmg`, the release workflow | `0.2.0` |
| Dev | `X.Y.(Z+1)-dev.YYYYMMDDHHmm` | `bun run package`, `mise run app:package`, `mise run app:install` | `0.2.1-dev.202611101432` |

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
- A dev build is a SemVer prerelease of the **next patch**: it sorts above the
  release it was built after and below the next one. The suffix is the local
  build time to the minute, so every install is newer than the last, with no
  counter to keep and nothing to commit.
- `--dev` and `--notarize` are refused together: a dev build is never
  released.

## Dev builds never update (INF-11)

The updater (`electron/main/updater/`) is off in any build whose
`app.getVersion()` has a prerelease tag, and in an unpackaged run: it never
checks, downloads or installs, and electron-updater is not even loaded. So a
dev install is never replaced by a release behind your back, and stays on the
build you made until the next `mise run app:install`. Settings → About says so
beside **Check now**. Only a release build (`X.Y.Z`, from the release
workflow) updates, from published GitHub Releases.

## Where it shows

`mise run app:install` prints the installed version. Finder's Get Info,
`app.getVersion()` and metrics (`v`) all carry the dev version, so a report
from a dev build is never mistaken for one from a release.
