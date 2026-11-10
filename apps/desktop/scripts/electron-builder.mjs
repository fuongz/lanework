// INF-08: runs electron-builder for `bun run package` and `bun run dist`, and
// decides how the macOS build is signed.
//
// - LANEWORK_MAC_IDENTITY unset (contributors, the gate workflow): ad hoc, as
//   configured in electron-builder.yml, with the ad hoc entitlements.
// - LANEWORK_MAC_IDENTITY set (the gitignored mise.local.toml, or the release
//   workflow's `release` environment): signed with that Developer ID ("Name
//   (TEAMID)", without the "Developer ID Application: " prefix) and the
//   Developer ID entitlements, which keep library validation on. A stable Team ID signature is also what lets
//   macOS keep the app's microphone, notification and Keychain grants from
//   one local install to the next.
// - `--notarize` (dist only) notarizes that signed build, the app and (INF-09,
//   scripts/dmg-notarize.mjs) its DMG, with the `xcrun notarytool
//   store-credentials` profile in LANEWORK_NOTARY_PROFILE, or else an App
//   Store Connect API key in APPLE_API_KEY, APPLE_API_KEY_ID and
//   APPLE_API_ISSUER.
//   Without it, every APPLE_* variable electron-builder notarizes from is
//   dropped: electron-builder notarizes after any signing it does, so one
//   left in the environment would send each local package to Apple.
//
// Any other argument goes to electron-builder as is.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const NOTARIZE_ENV = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
];

const args = process.argv.slice(2);
const notarize = args.includes("--notarize");
const builderArgs = args.filter((arg) => arg !== "--notarize");

const env = { ...process.env };
for (const name of NOTARIZE_ENV) delete env[name];

const identity = process.env.LANEWORK_MAC_IDENTITY?.trim();
if (process.platform === "darwin" && identity) {
  builderArgs.push(
    `-c.mac.identity=${identity}`,
    "-c.mac.entitlements=build/entitlements.mac.developer-id.plist",
    "-c.mac.entitlementsInherit=build/entitlements.mac.developer-id.inherit.plist",
  );
  if (notarize) {
    // A maintainer's Mac: a stored notarytool profile. CI (INF-09,
    // .github/workflows/release.yml): an App Store Connect API key.
    const profile = process.env.LANEWORK_NOTARY_PROFILE?.trim();
    const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
    if (profile) {
      env.APPLE_KEYCHAIN_PROFILE = profile;
    } else if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
      Object.assign(env, { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER });
    } else {
      console.error(
        "No notarize credentials: set LANEWORK_NOTARY_PROFILE, or APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER. A signed build that is not notarized is refused by Gatekeeper on other Macs.",
      );
      process.exit(1);
    }
  }
}

const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("electron-builder/package.json")),
  "cli.js",
);
const result = spawnSync(process.execPath, [cli, ...builderArgs], {
  stdio: "inherit",
  env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
