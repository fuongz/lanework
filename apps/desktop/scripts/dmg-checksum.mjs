// INF-05 (SW-05): electron-builder's `artifactBuildCompleted` hook. The DMG is
// ad-hoc signed and not notarized, so nothing attests where it came from; a
// SHA-256 published next to it is what lets a user check the download.
// Writes `<installer>.dmg.sha256` in `shasum -a 256 -c` format.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

/** @param {{ file: string }} artifact */
export default async function dmgChecksum({ file }) {
  if (!file.endsWith(".dmg")) return;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  await writeFile(
    `${file}.sha256`,
    `${hash.digest("hex")}  ${basename(file)}\n`,
  );
}
