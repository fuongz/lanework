// Stages the released `lwk` (FE-158): downloads the archive pinned in
// `lwk.lock.json` from github.com/lanework-dev/kit, checks its sha256, and
// extracts only the `lwk` binary into `dist/electron/bin/lwk-<arch>`, beside
// the `rg-<arch>` that `fetch-ripgrep.mjs` stages. `electron-builder.yml`
// unpacks `dist/electron/bin/**`, and `electron/main/agent-setup/lwk-install.ts`
// links `~/.lanew/bin/lwk` to it.
//
// - On macOS both arm64 and x64 are staged (a build on either Mac can ship
//   either); elsewhere only this machine's.
// - Downloads are cached under node_modules/.cache/lanework-lwk, keyed by
//   version and hash. A cached archive is checked again before use.
// - A hash mismatch fails the build; nothing is extracted from such an archive.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, "node_modules/.cache/lanework-lwk");

/** Rust's target triple for a platform and CPU, as Node names them. */
const TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function readLock() {
  return JSON.parse(await readFile(join(root, "lwk.lock.json"), "utf8"));
}

/** The archive's bytes, from the cache or the release, checked against the lock. */
async function archiveFor(lock, triple) {
  const entry = lock.targets[triple];
  if (!entry) throw new Error(`lwk.lock.json has no target ${triple}`);
  const cached = join(cacheDir, `${lock.lwk}-${entry.sha256}`, entry.asset);
  if (existsSync(cached)) {
    const data = await readFile(cached);
    if (sha256(data) === entry.sha256) return data;
    await rm(cached, { force: true });
  }
  const url = `https://github.com/${lock.repo}/releases/download/${lock.tag}/${entry.asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = sha256(data);
  if (actual !== entry.sha256)
    throw new Error(
      `${entry.asset}: sha256 mismatch (expected ${entry.sha256}, got ${actual})`,
    );
  await mkdir(dirname(cached), { recursive: true });
  const part = `${cached}.part`;
  await writeFile(part, data);
  await rename(part, cached);
  return data;
}

/** Extracts only `lwk` from the verified archive into `target`. */
async function extractLwk(data, asset, triple, target) {
  // Unpacked in a fresh, empty folder; only the binary leaves it.
  const work = await mkdtemp(join(tmpdir(), "lanework-lwk-"));
  try {
    await writeFile(join(work, asset), data);
    const member = `lanework-kit-${triple}/lwk`;
    const result = spawnSync("tar", ["-xJf", asset, member], {
      cwd: work,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error || result.status !== 0)
      throw new Error(`could not unpack ${asset} (needs tar with xz support)`);
    // NOTE: A new file renamed over the old one, never a write in place.
    // macOS keeps a signed binary's verdict per file: overwriting the bytes
    // of one it already ran makes the kernel kill the next run (SIGKILL,
    // exit 137) even though the new bytes are signed too.
    const next = `${target}.part`;
    await copyFile(join(work, member), next);
    await chmod(next, 0o755);
    await rename(next, target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function fetchLwk(outdir = join(root, "dist/electron")) {
  const lock = await readLock();
  const arches =
    process.platform === "darwin" ? ["arm64", "x64"] : [process.arch];
  const bin = join(outdir, "bin");
  await mkdir(bin, { recursive: true });
  for (const arch of arches) {
    const triple = TRIPLES[`${process.platform}-${arch}`];
    if (!triple)
      throw new Error(`no lwk release for ${process.platform}-${arch}`);
    const data = await archiveFor(lock, triple);
    await extractLwk(
      data,
      lock.targets[triple].asset,
      triple,
      join(bin, `lwk-${arch}`),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await fetchLwk();
  } catch (error) {
    console.error(`[lwk] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
