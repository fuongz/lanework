// Stages ripgrep for fs-kit (FE-149): copies the pinned @vscode/ripgrep
// binary into `dist/electron/bin/rg-<arch>`, where
// `electron/main/fs-kit/rg.ts` finds it. `electron-builder.yml` already
// unpacks `dist/electron/bin/**` (the dictation helper lives there too), so an
// app spawns it from outside the asar archive.
//
// On macOS both arm64 and x64 are staged, so a build made on either Mac can
// ship either architecture. bun installs only this machine's optional
// platform package, so the other one is fetched from the npm registry at the
// version and sha512 that bun.lock pins, and cached under node_modules/.cache.
// Elsewhere only this machine's binary is staged.
//
// NOTE: The app never falls back to an `rg` on PATH: what runs is this copy,
// or, unpackaged, the one in node_modules.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lockfile = join(root, "../../bun.lock");
const cacheDir = join(root, "node_modules/.cache/lanework-ripgrep");

const require = createRequire(import.meta.url);
/** Resolves from inside @vscode/ripgrep, where bun links its platform packages. */
const ripgrepEntry = await realpath(require.resolve("@vscode/ripgrep"));
const ripgrepRequire = createRequire(ripgrepEntry);

/** The pinned version: @vscode/ripgrep's own, which its platform packages match. */
async function pinnedVersion() {
  const pkg = join(dirname(dirname(ripgrepEntry)), "package.json");
  return JSON.parse(await readFile(pkg, "utf8")).version;
}

/** The sha512 integrity bun.lock records for `name@version`. */
async function lockedIntegrity(name, version) {
  const text = await readFile(lockfile, "utf8");
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = text.match(
    new RegExp(`"${escaped}",[^\\n]*?"(sha512-[A-Za-z0-9+/=]+)"`),
  );
  if (!match)
    throw new Error(`bun.lock has no integrity for ${name}@${version}`);
  return match[1];
}

/** The installed binary for `platform-arch`, or null when bun skipped it. */
function installedBinary(platform, arch) {
  const exe = platform === "win32" ? "rg.exe" : "rg";
  try {
    return ripgrepRequire.resolve(
      `@vscode/ripgrep-${platform}-${arch}/bin/${exe}`,
    );
  } catch {
    return null;
  }
}

/** Downloads and checks the platform package, then returns its binary. */
async function fetchedBinary(platform, arch, version) {
  const name = `@vscode/ripgrep-${platform}-${arch}`;
  const target = join(cacheDir, `${platform}-${arch}-${version}`, "rg");
  if (existsSync(target)) return target;
  const integrity = await lockedIntegrity(name, version);
  const url = `https://registry.npmjs.org/${name}/-/ripgrep-${platform}-${arch}-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (actual !== integrity)
    throw new Error(`${name}@${version}: integrity mismatch`);
  // Unpacked in a fresh, empty folder; only the binary leaves it.
  const work = await mkdtemp(join(tmpdir(), "lanework-rg-"));
  try {
    await writeFile(join(work, "package.tgz"), tarball);
    const result = spawnSync("tar", ["-xzf", "package.tgz", "package/bin/rg"], {
      cwd: work,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error || result.status !== 0)
      throw new Error(`could not unpack ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(work, "package/bin/rg"), target);
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function fetchRipgrep(outdir = join(root, "dist/electron")) {
  const version = await pinnedVersion();
  const arches =
    process.platform === "darwin" ? ["arm64", "x64"] : [process.arch];
  const bin = join(outdir, "bin");
  await mkdir(bin, { recursive: true });
  for (const arch of arches) {
    const source =
      installedBinary(process.platform, arch) ??
      (process.platform === "darwin"
        ? await fetchedBinary(process.platform, arch, version)
        : null);
    if (!source)
      throw new Error(`no ripgrep binary for ${process.platform}-${arch}`);
    const exe = process.platform === "win32" ? ".exe" : "";
    const target = join(bin, `rg-${arch}${exe}`);
    await copyFile(source, target);
    await chmod(target, 0o755);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchRipgrep();
