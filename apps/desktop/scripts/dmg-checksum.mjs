// INF-05 (SW-05): electron-builder's `artifactBuildCompleted` hook. The DMG
// itself is not signed (the app inside is, and notarized when built with a
// Developer ID, INF-08; ad hoc otherwise), so a SHA-256 published next to it
// is what lets a user check the download.
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
