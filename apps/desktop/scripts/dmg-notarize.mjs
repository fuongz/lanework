// INF-09: electron-builder's `afterAllArtifactBuild` hook. electron-builder
// notarizes the app inside a DMG but leaves the DMG itself unsigned and
// without a ticket. On a release build this signs each DMG with the same
// Developer ID, notarizes and staples it, then rewrites its .sha256, which
// stapling made stale.
//
// INF-11: DMGs only. The zip (and its blockmap and latest-mac.yml) is left
// exactly as electron-builder wrote it: the app inside it is already signed,
// notarized and stapled, and latest-mac.yml carries the zip's sha512, which
// any change here would break.
//
// It runs only when scripts/electron-builder.mjs left both a Developer ID
// (LANEWORK_MAC_IDENTITY) and notarize credentials in the environment, which
// it does for `bun run dist` alone: package builds, ad hoc builds and
// contributors' builds pass through untouched.
import { execFileSync } from "node:child_process";
import dmgChecksum from "./dmg-checksum.mjs";

/** @returns {string[] | null} notarytool's credential arguments */
function notaryCredentials() {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (profile) {
    const keychain = process.env.APPLE_KEYCHAIN;
    return [
      "--keychain-profile",
      profile,
      ...(keychain ? ["--keychain", keychain] : []),
    ];
  }
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return [
      "--key",
      APPLE_API_KEY,
      "--key-id",
      APPLE_API_KEY_ID,
      "--issuer",
      APPLE_API_ISSUER,
    ];
  }
  return null;
}

/** @param {string} file @param {string} identity @param {string[]} credentials */
function signNotarizeStaple(file, identity, credentials) {
  console.log(`  • signing DMG  file=${file}`);
  execFileSync(
    "codesign",
    [
      "--force",
      "--timestamp",
      "--sign",
      `Developer ID Application: ${identity}`,
      file,
    ],
    { stdio: "inherit" },
  );
  console.log("  • notarizing DMG (waits for Apple, prints nothing meanwhile)");
  const submission = JSON.parse(
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        file,
        ...credentials,
        "--wait",
        "--output-format",
        "json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  if (submission.status !== "Accepted") {
    const log = execFileSync(
      "xcrun",
      ["notarytool", "log", submission.id, ...credentials],
      { encoding: "utf8" },
    );
    throw new Error(
      `notarization of ${file} ended ${submission.status} (${submission.id}):\n${log}`,
    );
  }
  execFileSync("xcrun", ["stapler", "staple", file], { stdio: "inherit" });
  console.log(`  • DMG notarized and stapled  id=${submission.id}`);
}

/** @param {{ artifactPaths: string[] }} result */
export default async function dmgNotarize({ artifactPaths }) {
  const dmgs = artifactPaths.filter((path) => path.endsWith(".dmg"));
  const identity = process.env.LANEWORK_MAC_IDENTITY?.trim();
  const credentials = notaryCredentials();
  if (
    process.platform !== "darwin" ||
    !dmgs.length ||
    !identity ||
    !credentials
  ) {
    return [];
  }
  for (const file of dmgs) {
    signNotarizeStaple(file, identity, credentials);
    await dmgChecksum({ file });
  }
  return [];
}
