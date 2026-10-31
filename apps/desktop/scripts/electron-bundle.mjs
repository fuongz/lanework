// What the main-process bundle is, spelled once for `build-electron.mjs` and
// `dev.mjs` — the two drifting apart is how a dev build works and a release
// build ships without a file.
import { cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
    // FE-87: the lead's `lanework-control`, on the same Node, from
    // ~/.lanew/bin/lanework-control.
    "control/lanework-control": "electron/control/main.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // NOTE: node-pty stays OUT of the bundle. Its `.node` binary and
  // `spawn-helper` are found relative to its own files, which bundling would
  // move. `stageNativeModules` puts it next to the bundle instead.
  external: ["electron", "@lydell/node-pty"],
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
}
