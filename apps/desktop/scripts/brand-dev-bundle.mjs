import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Clones Electron into a branded `Lanework.app` for development on macOS.
 *
 * macOS reads native branding from the running `.app`, in development too.
 * A clone leaves the installed dependency untouched.
 *
 * @returns The clone's binary, or `electron` as is off macOS.
 */
export function brandDevBundle(electron) {
  if (process.platform !== "darwin") return electron;
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = dirname(dirname(dirname(electron)));
  const icon = join(root, "build/icon.icns");
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const key = createHash("sha256")
    .update(source)
    .update(readFileSync(join(source, "Contents/Info.plist")))
    .update(readFileSync(icon))
    .update(version)
    // Bumped when how the clone is made changes, so an old one is rebuilt.
    .update("adhoc-signed")
    .digest("hex")
    .slice(0, 16);
  const cache = join(root, "node_modules/.lanework-dev", key);
  const bundle = join(cache, "Lanework.app");
  const binary = join(bundle, "Contents/MacOS/Electron");
  const ready = join(cache, "ready");
  if (existsSync(ready) && existsSync(binary)) return binary;
  mkdirSync(cache, { recursive: true });
  execFileSync("/usr/bin/ditto", [source, bundle]);
  copyFileSync(icon, join(bundle, "Contents/Resources/lanework.icns"));
  const plist = join(bundle, "Contents/Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleName: "Lanework",
    CFBundleDisplayName: "Lanework",
    CFBundleIdentifier: "com.lanework.desktop.dev",
    CFBundleIconFile: "lanework.icns",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  })) {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }
  // NOTE: Editing `Info.plist` breaks Electron's own signature, and macOS then
  // refuses the app's notifications (UNErrorDomain error 1, FE-70). An ad hoc
  // signature makes the bundle whole again under its new identifier.
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    bundle,
  ]);
  writeFileSync(ready, "");
  return binary;
}
