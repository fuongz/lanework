// What the main-process bundle is, spelled once for `build-electron.mjs` and
// `dev.mjs` — the two drifting apart is how a dev build works and a release
// build ships without a file.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * FE-151: the natives main loads unbundled through `electron/main/native/`.
 * `stageNativePackages` copies each with its runtime dependencies.
 */
export const NATIVE_PACKAGES = [
  // Fuzzy file finder; a Rust dylib opened through ffi-rs.
  "@ff-labs/fff-node",
  // File watching (FSEvents on macOS).
  "@parcel/watcher",
  // Structural search. ts/tsx/js/jsx/css/html are built in; the rest are
  // tree-sitter parsers it loads as dynamic languages.
  "@ast-grep/napi",
  "@ast-grep/lang-go",
  "@ast-grep/lang-json",
  "@ast-grep/lang-python",
  "@ast-grep/lang-rust",
];

const NATIVE_EXTERNALS = [...NATIVE_PACKAGES, "ffi-rs"];

export const electronBuildOptions = {
  entryPoints: {
    "main/index": "electron/main/index.ts",
    // The utility process every terminal lives in.
    "main/pty-host": "electron/main/terminal/host.ts",
    // FE-112: the Pull's worker thread, which reads the CLIs' transcripts off
    // main's thread. `sessions/pull.ts` finds it beside main's own bundle.
    "main/session-pull": "electron/main/sessions/pull-worker.ts",
    "preload/index": "electron/preload/index.ts",
    // The agents' Stop hook, run by Electron's own Node
    // (`ELECTRON_RUN_AS_NODE=1`) from the command Settings → Agents installs.
    "hook/lanework-checkpoint": "electron/hook/lanework-checkpoint.ts",
    // Claude's process-scoped `statusLine` wrapper, on the hook's Node.
    "statusline/claude-usage": "electron/statusline/claude-usage.ts",
    // The offline MCP server, on the same Node as the hook. Agent configs run
    // `ELECTRON_RUN_AS_NODE=1 <app> dist/electron/mcp-local/server.cjs`.
    "mcp-local/server": "electron/mcp-local/main.ts",
    // FE-152: the lanework-kit MCP server, on the same Node, from
    // ~/.lanew/bin/lanework-kit-mcp. Its natives resolve from here to
    // `dist/electron/node_modules`, as main's do.
    "mcp-kit/server": "electron/mcp-kit/main.ts",
    // FE-87: the lead's `lanework-control`, on the same Node, from
    // ~/.lanew/bin/lanework-control.
    "control/lanework-control": "electron/control/main.ts",
    // FE-152: `lwk`'s JS kit, on the same Node. The native lwk
    // (`apps/desktop/lwk/`, `dist/electron/bin/lwk-<arch>`) execs it when the
    // app is not up, and for `lwk hook`. Its natives and ripgrep resolve from
    // here, as mcp-kit's do.
    "lwk/standalone": "electron/lwk/cli.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // NOTE: node-pty stays OUT of the bundle. Its `.node` binary and
  // `spawn-helper` are found relative to its own files, which bundling would
  // move. `stageNativeModules` puts it next to the bundle instead.
  //
  // FE-151: neither do the coding-search natives. `electron/main/native/`
  // requires them at run time from `dist/electron/node_modules`, where
  // `stageNativePackages` copies them; listing them here keeps a stray static
  // import from pulling one into a bundle.
  external: ["electron", "@lydell/node-pty", ...NATIVE_EXTERNALS],
  outdir: "dist/electron",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
  // FE-80 (AM-07): what each output was built from, for the bundle-boundary
  // gate (`scripts/audit-electron.mjs`). See `writeMetafile`.
  metafile: true,
};

/**
 * Where `writeMetafile` puts the build's metafile.
 *
 * NOTE: Beside `dist/electron`, not in it. electron-builder ships everything
 * under `dist/electron`, and a map of the source tree has no business in a
 * release.
 */
export const METAFILE = "dist/electron-meta.json";

/** Writes an esbuild result's metafile for `scripts/audit-electron.mjs`. */
export async function writeMetafile(result, path = METAFILE) {
  if (!result.metafile) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result.metafile));
}

const require = createRequire(import.meta.url);

/**
 * Copies node-pty into `dist/electron/node_modules`, where `pty-host.cjs`
 * resolves it (FE-19/D9).
 *
 * It copies the JS shim and this platform's prebuilt binary.
 *
 * NOTE: The copy is dereferenced and not left to electron-builder. bun's
 * install is a store of symlinks that a packager cannot be trusted to follow.
 * electron-builder also copies every production `dependencies` entry's
 * node_modules into app.asar on top of `files`, so the desktop package.json
 * has none (INF-05): node-pty is a devDependency, and this copy is the only
 * one that ships. app.asar then holds `dist/` and package.json, and what is in
 * `dist` is what ships and what the tests boot. `asarUnpack` keeps the binary
 * and `spawn-helper` outside the archive, where they can be loaded and
 * executed.
 *
 * This platform's package only. A build for another OS or CPU is made on that
 * machine, the way the prebuilds themselves are.
 */
export async function stageNativeModules(outdir = "dist/electron") {
  const shim = dirname(await realpath(require.resolve("@lydell/node-pty")));
  const platformName = `@lydell/node-pty-${process.platform}-${process.arch}`;
  const binary = dirname(
    dirname(
      await realpath(
        createRequire(join(shim, "index.js")).resolve(platformName),
      ),
    ),
  );
  const target = join(outdir, "node_modules", "@lydell");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(shim, join(outdir, "node_modules", "@lydell/node-pty"), {
    recursive: true,
    dereference: true,
  });
  await cp(binary, join(outdir, "node_modules", platformName), {
    recursive: true,
    dereference: true,
  });
  // FE-151: the coding-search natives, staged the same way.
  await pruneNativePackages(outdir, await stageNativePackages(outdir));
}

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeCache = join(desktopRoot, "node_modules/.cache/lanework-natives");

/** Dependencies needed only to compile from source, never at run time. */
const BUILD_ONLY = new Set(["node-addon-api"]);

/**
 * Package files a staged copy leaves behind: native sources (the prebuilt
 * binary is what runs), source maps and type declarations.
 */
function keepFile(packageDir, path) {
  const rel = relative(packageDir, path).split(sep).join("/");
  if (rel === "") return true;
  if (rel === "src" || rel.startsWith("src/")) return false;
  if (/\.(map|d\.ts|d\.mts|d\.cts|cc|hh|gyp|flow)$/.test(rel)) return false;
  // @ast-grep/lang-*: tree-sitter prebuilds for every OS; keep this one's.
  const prebuild = rel.match(/^prebuilds\/prebuild-([A-Za-z]+)-/);
  if (prebuild) return prebuild[1] === PREBUILD_OS[process.platform];
  return true;
}

/** @ast-grep/setup-lang's names for the OS a prebuild is for. */
const PREBUILD_OS = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/**
 * `name`'s folder as Node would find it from `fromDir`, through symlinks.
 *
 * NOTE: Walked by hand, not `require.resolve(name + "/package.json")`: a
 * package with an `exports` map that omits package.json would refuse it.
 */
async function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** The sha512 integrity bun.lock records for `name@version`. */
async function lockedIntegrity(name, version) {
  const text = await readFile(join(desktopRoot, "../../bun.lock"), "utf8");
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = text.match(
    new RegExp(`"${escaped}",[^\\n]*?"(sha512-[A-Za-z0-9+/=]+)"`),
  );
  if (!match)
    throw new Error(`bun.lock has no integrity for ${name}@${version}`);
  return match[1];
}

/**
 * Downloads `name@version` from the npm registry, checks it against
 * bun.lock, and unpacks it under node_modules/.cache. Returns its folder.
 *
 * For the other Mac's platform package, which bun does not install here,
 * as `scripts/fetch-ripgrep.mjs` does for rg.
 */
async function fetchPackage(name, version) {
  const target = join(nativeCache, `${name.replace("/", "+")}@${version}`);
  if (existsSync(join(target, "package.json"))) return target;
  const integrity = await lockedIntegrity(name, version);
  const url = `https://registry.npmjs.org/${name}/-/${basename(name)}-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (actual !== integrity)
    throw new Error(`${name}@${version}: integrity mismatch`);
  // Unpacked in a fresh, empty folder, then moved into the cache whole.
  const work = await mkdtemp(join(tmpdir(), "lanework-native-"));
  try {
    await writeFile(join(work, "package.tgz"), tarball);
    const result = spawnSync("tar", ["-xzf", "package.tgz", "package"], {
      cwd: work,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error || result.status !== 0)
      throw new Error(`could not unpack ${name}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(join(work, "package"), target, { recursive: true });
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Whether an optional dependency is the other Mac's platform package. */
function otherMacPackage(name) {
  if (process.platform !== "darwin") return false;
  const other = process.arch === "arm64" ? "x64" : "arm64";
  return name.endsWith(`-darwin-${other}`);
}

/**
 * FE-151: copies {@link NATIVE_PACKAGES} and their run-time dependencies,
 * flat, into `dist/electron/node_modules`, where `electron/main/native/`
 * requires them. Copied as node-pty is (see {@link stageNativeModules}):
 * dereferenced, and unpacked from the asar by `electron-builder.yml`, since
 * a `.node`, `.dylib` or `.so` cannot be loaded from inside it.
 *
 * Each package's platform binaries come from its optional dependencies:
 * this machine's, which bun installed, and on macOS the other CPU's too,
 * fetched from the registry at the version and sha512 bun.lock pins. The
 * other CPU's are best effort: the release is arm64-only, so a failed fetch
 * (offline, say) is a warning, not a failed build.
 *
 * @throws When two packages need different versions of one dependency,
 *   which a flat folder cannot hold.
 */
export async function stageNativePackages(outdir = "dist/electron") {
  const modules = join(outdir, "node_modules");
  const staged = new Map();
  const queue = NATIVE_PACKAGES.map((name) => ({
    name,
    from: desktopRoot,
    optional: false,
  }));
  while (queue.length) {
    const { name, from, optional, version } = queue.shift();
    let dir = await findPackage(name, from);
    if (!dir && version && otherMacPackage(name)) {
      try {
        dir = await fetchPackage(name, version);
      } catch (error) {
        console.warn(`[natives] skipped ${name}@${version}: ${error.message}`);
      }
    }
    if (!dir) {
      if (optional) continue;
      throw new Error(`${name} is not installed; run \`bun install\``);
    }
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const seen = staged.get(name);
    if (seen) {
      if (seen !== pkg.version)
        throw new Error(
          `${name}: ${seen} and ${pkg.version} both needed; dist/electron/node_modules is flat`,
        );
      continue;
    }
    staged.set(name, pkg.version);
    const target = join(modules, name);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(dir, target, {
      recursive: true,
      dereference: true,
      filter: (path) => keepFile(dir, path),
    });
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      if (!BUILD_ONLY.has(dep))
        queue.push({ name: dep, from: dir, optional: false });
    for (const [dep, range] of Object.entries(pkg.optionalDependencies ?? {}))
      queue.push({ name: dep, from: dir, optional: true, version: range });
  }
  return [...staged.keys()];
}

/** Packages staged by an earlier build that this one no longer needs. */
export async function pruneNativePackages(outdir, keep) {
  const modules = join(outdir, "node_modules");
  if (!existsSync(modules)) return;
  const wanted = new Set(keep);
  for (const entry of await readdir(modules)) {
    if (entry === "@lydell") continue;
    const names = entry.startsWith("@")
      ? (await readdir(join(modules, entry))).map((n) => `${entry}/${n}`)
      : [entry];
    for (const name of names)
      if (!wanted.has(name))
        await rm(join(modules, name), { recursive: true, force: true });
  }
}
