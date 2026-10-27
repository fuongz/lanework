// The shell a terminal runs and the environment it starts with.
//
// NOTE: No native imports (FE-80, AM-01). The main process, the harness and
// the chat CLI need these too, and importing them from `sessions.ts` dragged
// node-pty's addon and xterm headless into the main bundle.

export interface ShellChoice {
  file: string;
  args: string[];
}

/**
 * The shell a terminal runs, as a LOGIN shell (FE-19/D7).
 *
 * NOTE: `-l` is the point. A Mac app opened from the Dock inherits launchd's
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so without the user's profile
 * `bun`, `claude` and everything Homebrew installed are "command not found".
 * `LANEWORK_TERMINAL_SHELL` is the tests' way to pin a plain `/bin/sh`.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
): ShellChoice {
  if (process.platform === "win32")
    return { file: env.COMSPEC || "powershell.exe", args: [] };
  const file =
    env.LANEWORK_TERMINAL_SHELL ||
    env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: ["-l"] };
}

/**
 * The environment a shell starts with: the app's, minus the app's own.
 *
 * NOTE: `LANEWORK_*` and `ELECTRON_*` are the APP's switches: its home
 * folder, its API, `ELECTRON_RUN_AS_NODE`. A shell that inherited them would
 * run the next `lanework` or `electron` it launched against the wrong home,
 * or not as an app at all. They are deleted, not blanked: an empty value is
 * still set.
 */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("LANEWORK_") || key.startsWith("ELECTRON_")) continue;
    out[key] = value;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.TERM_PROGRAM = "Lanework";
  // Dock-launched apps get no locale, and without one a shell treats every
  // byte past ASCII ("Dự án") as garbage.
  if (!out.LANG && process.platform === "darwin") out.LANG = "en_US.UTF-8";
  return out;
}
