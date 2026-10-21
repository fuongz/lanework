// Builds the dictation helper: compiles `native/dictation/main.swift` into
// `dist/electron/bin/`, where main spawns it. Shared by `build-electron.mjs`
// and `dev.mjs`, like `electron-bundle.mjs`.
//
// macOS only. Where `swiftc` is missing it warns and does not fail. The
// composer hides its microphone when the helper is absent, so such a build
// only lacks dictation.
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "native/dictation/main.swift");

/** The file's modification time in ms, or `0` when it does not exist. */
const mtime = (path) =>
  stat(path).then(
    (found) => found.mtimeMs,
    () => 0,
  );

export async function buildDictation(outdir = "dist/electron") {
  if (process.platform !== "darwin") return;
  const output = join(root, outdir, "bin/lanework-dictation");
  // Only when the source changed: a dev restart should not wait on swiftc.
  if ((await mtime(output)) >= (await mtime(source))) return;
  await mkdir(dirname(output), { recursive: true });
  const result = spawnSync(
    "xcrun",
    ["swiftc", "-O", "-swift-version", "5", source, "-o", output],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.error || result.status !== 0)
    console.warn(
      "lanework-dictation was not built (swiftc unavailable or failed); the composer will have no microphone.",
    );
}
