// Writing a config file that belongs to the user and to another tool
// (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.claude.json`,
// `~/.codex/config.toml`, and every file Settings → Agents edits), so that
// writing it changes its text and nothing else (INF-05, SX-08):
//
// - A symlink is followed, and the file it points at is replaced. A
//   dotfiles-managed link stays a link.
// - The file keeps its mode. A 0600 settings.json holding `env` keys or an
//   `apiKeyHelper` is not widened to 0644, whatever the umask.
// - The write is atomic: a temp file beside the target, then a rename. A crash
//   mid-write cannot leave the other tool half a file.
// - The bytes are compared just before the rename. A file the other tool
//   changed since it was read is not overwritten.
//
// NOTE: Node only, no Electron: main calls it, and specs drive the callers
// under plain Node against a fake home.
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The file a write lands in.
 *
 * It follows a symlink to what it points at, so a dotfiles link stays a link.
 * A file not there yet is its own target.
 */
export async function configTarget(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/** The bytes at `path`, or null when there is no file. Other errors throw. */
export async function readConfigBytes(path: string): Promise<Buffer | null> {
  return readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

const same = (a: Buffer | null, b: Buffer | null) =>
  a === null || b === null ? a === b : a.equals(b);

/**
 * Replace `target` with `text`, keeping its mode, if it still holds `before`.
 *
 * @param target A path {@link configTarget} resolved: never a symlink.
 * @param before The bytes it was read at; null for a file that did not exist.
 * @param newMode The mode of a file that did not exist yet.
 * @returns False, and nothing written, when the file no longer holds
 *   `before`.
 */
export async function replaceConfigFile(
  target: string,
  text: string,
  before: Buffer | null,
  newMode = 0o644,
): Promise<boolean> {
  const info = before ? await stat(target).catch(() => null) : null;
  const mode = info ? info.mode & 0o777 : newMode;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.lanework-${process.pid}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", mode });
    // `mode` above is masked by the umask; this is not.
    await chmod(temp, mode);
    if (!same(await readConfigBytes(target), before)) {
      await rm(temp, { force: true });
      return false;
    }
    await rename(temp, target);
    return true;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Read, change and write back a config file another tool also writes.
 *
 * `change` gets the file's text (null when there is none) and returns the new
 * text, or null to leave the file alone. When the file changed between the
 * read and the write, it is read and changed again, once.
 *
 * @param newMode The mode of a file that did not exist yet.
 * @returns Whether the file was written.
 * @throws What `change` throws, and when the file changed twice under it.
 */
export async function updateConfigFile(
  path: string,
  change: (text: string | null) => string | null,
  newMode = 0o644,
): Promise<boolean> {
  const target = await configTarget(path);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readConfigBytes(target);
    const text = before ? before.toString("utf8") : null;
    const next = change(text);
    if (next === null || next === text) return false;
    if (await replaceConfigFile(target, next, before, newMode)) return true;
  }
  throw new Error(
    `${path} kept changing while Lanework wrote it. Try again in a moment.`,
  );
}
