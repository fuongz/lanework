// Installs `lwk` (FE-152) at `~/.lanew/bin/lwk`: a symlink to this build's
// `dist/electron/bin/lwk-<arch>`, the native client `scripts/build-lwk.mjs`
// builds from `apps/desktop/lwk/` and `electron-builder.yml` unpacks from
// the asar.
//
// - A link, not a copy and not a shell shim: lwk finds the app beside its
//   real path (its JS kit, `dist/electron/lwk/standalone.cjs`, and the app's
//   executable to run it on), and a shim's `sh` would cost a passthrough
//   (`lwk git status`) its start-up time.
// - Replaced atomically (a new link, then a rename), so an agent running
//   lwk meanwhile sees the old one or the new one, never none.
//
// NOTE: Rewritten on every launch, like `lanework-control`
// (`../../control/install.ts`): the bundle moves with every update or move
// of the app; the link's own path never does. No Electron.
import { existsSync } from "node:fs";
import { mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { appHomeDir } from "../paths";

/** `~/.lanew/bin/lwk`: what an agent or a person runs. */
export function lwkPath(): string {
  return join(appHomeDir(), "bin", "lwk");
}

/**
 * This build's lwk for `arch`, outside the asar archive.
 *
 * @param mainDir The main bundle's folder, `dist/electron/main`.
 */
export function lwkBinaryPath(
  mainDir: string = __dirname,
  arch: string = process.arch,
): string {
  return join(mainDir, "..", "bin", `lwk-${arch}`).replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
}

/**
 * Point `~/.lanew/bin/lwk` at this build's binary.
 *
 * Cheap, so every launch does it; a link already right is left alone.
 *
 * @returns The link's path, or null when this build has no lwk (a dev run
 *   before `bun run build`, or a platform it is not built for).
 */
export async function installLwk(
  binary: string = lwkBinaryPath(),
): Promise<string | null> {
  if (process.platform === "win32" || !existsSync(binary)) return null;
  const path = lwkPath();
  if ((await readlink(path).catch(() => null)) === binary) return path;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.lanework-${process.pid}.tmp`;
  await rm(temp, { force: true });
  try {
    await symlink(binary, temp);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return path;
}
