// What the main-process bundle is, spelled once for `build-electron.mjs` and
// `dev.mjs` — the two drifting apart is how a dev build works and a release
// build ships without a file.
import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const electronBuildOptions = {
  entryPoints: {
    "main/index": "electron/main/index.ts",
    // FE-19: the utility process every terminal lives in.
    "main/pty-host": "electron/main/terminal/host.ts",
    "preload/index": "electron/preload/index.ts",
    // FE-28: the Claude Code Stop hook, run by Electron's own Node
    // (`ELECTRON_RUN_AS_NODE=1`) from the command Settings → Agents installs.
    "hook/lanework-checkpoint": "electron/hook/lanework-checkpoint.ts",
    // FE-46: process-scoped Claude statusLine wrapper, same Node as the hook.
    "statusline/claude-usage": "electron/statusline/claude-usage.ts",
    // FE-52: the offline MCP server, same Node as the hook. Agent configs run
    // `ELECTRON_RUN_AS_NODE=1 <app> dist/electron/mcp-local/server.cjs`.
    "mcp-local/server": "electron/mcp-local/main.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // ⚠️ node-pty stays OUT of the bundle: its `.node` binary and
  // `spawn-helper` are found relative to its own files, which bundling would
  // move. `stageNativeModules` puts it next to the bundle instead.
  external: ["electron", "@lydell/node-pty"],
  outdir: "dist/electron",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
};

const require = createRequire(import.meta.url);

/**
 * Copy node-pty — the JS shim and this platform's prebuilt binary — into
 * `dist/electron/node_modules`, where `pty-host.cjs` resolves it (FE-19/D9).
 *
 * ⚠️ Copied, dereferenced, rather than left to electron-builder. `files` is
 * `dist/**` only, and bun's install is a store of symlinks that a packager
 * cannot be trusted to follow; what is in `dist` is what ships and what the
 * tests boot. `asarUnpack` then keeps the binary and `spawn-helper` outside
 * the archive, where they can be loaded and executed.
 *
 * ⚠️ This platform's package only. A build for another OS or CPU is made on
 * that machine, the way the prebuilds themselves are.
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
