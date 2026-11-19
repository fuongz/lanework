// Fails when the fetched lwk (`dist/electron/bin/lwk-<arch>`) reports a
// version or contract other than the ones `lwk.lock.json` pins (FE-158).
// It runs this machine's binary: `lwk version --json` prints
// `{"lwk":"X.Y.Z","contract":"A.B.C"}`.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(root, "lwk.lock.json"), "utf8"));
const binary = join(root, "dist/electron/bin", `lwk-${process.arch}`);

function fail(message) {
  console.error(`[lwk] contract check: ${message}`);
  process.exit(1);
}

const result = spawnSync(binary, ["version", "--json"], { encoding: "utf8" });
if (result.error) fail(`could not run ${binary}: ${result.error.message}`);
if (result.status !== 0) fail(`${binary} exited ${result.status}`);
let reported;
try {
  reported = JSON.parse(result.stdout);
} catch {
  fail(`unparseable \`lwk version --json\` output: ${result.stdout}`);
}
for (const key of ["lwk", "contract"]) {
  if (reported[key] !== lock[key])
    fail(`${key} is ${reported[key]}, lwk.lock.json pins ${lock[key]}`);
}
console.log(`[lwk] contract ok: lwk ${lock.lwk}, contract ${lock.contract}`);
