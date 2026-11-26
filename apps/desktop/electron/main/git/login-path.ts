// The user's login-shell PATH, for every `git` the app runs.
//
// An app opened from the Dock inherits launchd's PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`). `git` itself is there, but what git
// starts by name is not: `git lfs pre-push` from the hook `git lfs install`
// writes, the LFS clean and smudge filters, a husky or lefthook hook that
// runs `bun`. They all fail in the app and pass in a terminal. So git runs
// with the PATH a terminal tab has, asked once from the user's shell.
import { afterMarker, runInLoginShell } from "../harness/shell";

/** Fences the shell's answer off from whatever the profile prints. */
const MARK = "__lanework_git_path__";

let found: Promise<string | null> | null = null;

/**
 * The user's login and interactive shell's PATH, asked once and reused.
 *
 * Never throws. Null on Windows, or when the shell failed or took over 10
 * seconds; git then keeps this process's PATH.
 */
export function loginPath(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  found ??= runInLoginShell(
    `printf '\\n%s\\n' '${MARK}'; printf '%s\\n' "$PATH"`,
    { timeoutMs: 10_000 },
  )
    .then(({ stdout }) => {
      const line = afterMarker(stdout, MARK)?.trim().split("\n")[0]?.trim();
      return line || null;
    })
    .catch(() => null);
  return found;
}

/**
 * `env` with the login shell's PATH in front of its own.
 *
 * Its own entries stay after, deduplicated, so a directory only this process
 * had (a test's fake binary) is still found.
 */
export async function withLoginPath(
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const shell = await loginPath();
  if (!shell) return env;
  const dirs = [...shell.split(":"), ...(env.PATH ?? "").split(":")];
  return { ...env, PATH: [...new Set(dirs.filter(Boolean))].join(":") };
}
