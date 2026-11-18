// Builds `lwk` (FE-152), the native client in `apps/desktop/lwk/` (Rust),
// into `dist/electron/bin/lwk-<arch>`, beside the `rg-<arch>` that
// `fetch-ripgrep.mjs` stages. `electron-builder.yml` already unpacks
// `dist/electron/bin/**`, and `electron/main/agent-setup/lwk-install.ts`
// links `~/.lanew/bin/lwk` to it.
//
// - Native, not a bundle on the app's Node: a passthrough (`lwk git status`)
//   and `lwk rewrite` (every Bash call, with the hook on) pay for start-up
//   alone, and Electron's Node takes tens of milliseconds to start. The JS
//   half (`electron/lwk/cli.ts`, `dist/electron/lwk/standalone.cjs`) is an
//   esbuild entry of `electron-bundle.mjs`, built with main.
// - macOS: arm64 always (the release's), x64 only when rustup lists its
//   target as installed (`rustup target add x86_64-apple-darwin`), so a
//   machine without it builds quietly instead of printing cargo's E0463. A
//   failed x64 build is a warning, as the other CPU's natives are.
//   Elsewhere: this machine's.
// - Cargo's own output stays in `apps/desktop/lwk/target/` (git-ignored);
//   only the binaries are copied into dist.
// - No cargo: a clear error and a failed build, never a build without lwk.
//
//   node scripts/build-lwk.mjs [--outdir DIR]   (DIR/bin/lwk-<arch>)
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const crate = join(root, "lwk");

/** Rust's target triple for a Mac CPU, as Node names it. */
const MAC_TRIPLES = {
  arm64: "aarch64-apple-darwin",
  x64: "x86_64-apple-darwin",
};

function fail(message) {
  console.error(`[lwk] ${message}`);
  process.exit(1);
}

/** Whether rustup lists `triple` as installed (false without rustup). */
function targetInstalled(triple) {
  const result = spawnSync("rustup", ["target", "list", "--installed"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => line.trim() === triple);
}

/** Run cargo with `args` in the crate. @returns Whether it succeeded. */
function cargo(args, env) {
  const result = spawnSync("cargo", args, {
    cwd: crate,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error?.code === "ENOENT")
    fail(
      "cargo is not installed, and lwk is built with it. Install Rust (https://rustup.rs), then run `bun run build` again.",
    );
  if (result.error) throw result.error;
  return result.status === 0;
}

export async function buildLwk(outdir = join(root, "dist/electron")) {
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const env = { LWK_VERSION: version };
  const bin = join(outdir, "bin");
  await mkdir(bin, { recursive: true });
  const exe = process.platform === "win32" ? ".exe" : "";
  // [arch, triple or null for this machine's, required]
  const builds =
    process.platform === "darwin"
      ? [
          ["arm64", MAC_TRIPLES.arm64, true],
          ["x64", MAC_TRIPLES.x64, false],
        ]
      : [[process.arch, null, true]];
  for (const [arch, triple, required] of builds) {
    const outfile = join(bin, `lwk-${arch}${exe}`);
    const target = triple ? ["--target", triple] : [];
    if (!required && !targetInstalled(triple)) {
      // An old binary left here would ship as if it were this build's.
      await rm(outfile, { force: true });
      continue;
    }
    if (!cargo(["build", "--release", "--locked", "-q", ...target], env)) {
      if (required) fail(`cargo build failed for lwk-${arch}`);
      console.warn(
        `[lwk] skipped lwk-${arch}: cargo build failed (is the ${triple} target installed?)`,
      );
      // An old binary left here would ship as if it were this build's.
      await rm(outfile, { force: true });
      continue;
    }
    const built = join(
      crate,
      "target",
      ...(triple ? [triple] : []),
      "release",
      `lwk${exe}`,
    );
    // A new file renamed over the old, never rewritten in place: macOS
    // kills a process whose binary's pages change under its signature, and
    // `~/.lanew/bin/lwk` may be running this one.
    const temp = `${outfile}.${process.pid}.tmp`;
    await copyFile(built, temp);
    await chmod(temp, 0o755);
    await rename(temp, outfile);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--outdir");
  await buildLwk(at === -1 ? undefined : resolve(process.argv[at + 1]));
}
