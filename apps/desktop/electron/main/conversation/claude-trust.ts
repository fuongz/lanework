// Whether Claude Code itself trusts a folder (FE-77/D3, finding SX-01).
//
// The chat's engine runs `claude -p`, and in `-p` mode Claude treats the
// folder as trusted without asking: a repo's `.claude/settings.json` hooks,
// `env` and `apiKeyHelper` would run as the user with no dialog. So the engine
// asks Claude's own trust record first, the one its interactive trust dialog
// writes: `projects[<folder or an ancestor>].hasTrustDialogAccepted` in
// `~/.claude.json`. Without it, the engine loads user settings only.
//
// NOTE: Node only, no Electron, so a script can call it. Any doubt (missing,
// too big, unreadable, half written) answers "not trusted".
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claudeJsonPath } from "../agent-home";
import { updateConfigFile } from "../config-file";

/** `~/.claude.json` keeps every project's history: it can be large. */
const CLAUDE_JSON_MAX = 32 * 1024 * 1024;

/**
 * The `.claude.json` the engine's `claude` reads.
 *
 * `CLAUDE_CONFIG_DIR` as the CLI's own environment has it (the login shell's,
 * which may set it when main's does not), else `home`'s.
 */
export function claudeJsonFor(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : claudeJsonPath(home);
}

/** `folder` and every folder above it, nearest first. */
function ancestors(folder: string): string[] {
  const out: string[] = [];
  let at = resolve(folder);
  for (;;) {
    out.push(at);
    const up = dirname(at);
    if (up === at) return out;
    at = up;
  }
}

/**
 * Whether `claudeJson`'s record trusts `folder`, read as Claude reads it.
 *
 * Keys are compared as stored (case-sensitive): the folder as given and as
 * its real path, then each of their ancestors.
 */
export function trustedIn(
  claudeJson: unknown,
  folder: string,
  real: string = folder,
): boolean {
  if (!claudeJson || typeof claudeJson !== "object") return false;
  const projects = (claudeJson as { projects?: unknown }).projects;
  if (!projects || typeof projects !== "object") return false;
  const record = projects as Record<string, unknown>;
  const seen = new Set<string>();
  for (const path of [...ancestors(folder), ...ancestors(real)]) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!Object.hasOwn(record, path)) continue;
    const project = record[path];
    if (
      project &&
      typeof project === "object" &&
      (project as { hasTrustDialogAccepted?: unknown })
        .hasTrustDialogAccepted === true
    )
      return true;
  }
  return false;
}

/**
 * Whether Claude has recorded the user's trust in `folder` (or a folder
 * above it).
 *
 * Read fresh on every call: the trust the user gives in a Claude tab counts
 * from the chat's next engine start.
 *
 * @param claudeJson The `.claude.json` to read; see {@link claudeJsonFor}.
 */
export async function isClaudeTrusted(
  folder: string,
  claudeJson = claudeJsonFor(),
): Promise<boolean> {
  try {
    const info = await stat(claudeJson);
    if (!info.isFile() || info.size > CLAUDE_JSON_MAX) return false;
    const parsed: unknown = JSON.parse(await readFile(claudeJson, "utf8"));
    const real = await realpath(folder).catch(() => resolve(folder));
    return trustedIn(parsed, folder, real);
  } catch {
    return false;
  }
}

/**
 * Claude's trust in `folder`, told apart: its own record, and the folder above
 * it that trusts it when its own does not (FE-101).
 *
 * @returns `own` true, false or null (no record); `from` the nearest ancestor
 *   whose record trusts it, null when none does or the folder's own does.
 */
export function claudeTrustOf(
  claudeJson: unknown,
  folder: string,
  real: string = folder,
): { own: boolean | null; from: string | null } {
  const projects =
    claudeJson && typeof claudeJson === "object"
      ? (claudeJson as { projects?: unknown }).projects
      : null;
  const record =
    projects && typeof projects === "object"
      ? (projects as Record<string, unknown>)
      : {};
  const accepted = (path: string): boolean | null => {
    if (!Object.hasOwn(record, path)) return null;
    const value = (record[path] as { hasTrustDialogAccepted?: unknown } | null)
      ?.hasTrustDialogAccepted;
    return typeof value === "boolean" ? value : null;
  };
  const own = accepted(resolve(real)) ?? accepted(resolve(folder));
  if (own === true) return { own, from: null };
  const self = new Set([resolve(folder), resolve(real)]);
  for (const path of [...ancestors(folder), ...ancestors(real)])
    if (!self.has(path) && accepted(path) === true) return { own, from: path };
  return { own, from: null };
}

/** {@link claudeTrustOf}, read fresh from `claudeJson`; any doubt reads as none. */
export async function readClaudeTrust(
  folder: string,
  claudeJson = claudeJsonFor(),
): Promise<{ own: boolean | null; from: string | null }> {
  try {
    const info = await stat(claudeJson);
    if (!info.isFile() || info.size > CLAUDE_JSON_MAX)
      return { own: null, from: null };
    const parsed: unknown = JSON.parse(await readFile(claudeJson, "utf8"));
    const real = await realpath(folder).catch(() => resolve(folder));
    return claudeTrustOf(parsed, folder, real);
  } catch {
    return { own: null, from: null };
  }
}

/**
 * Record the user's answer to Claude's trust question for `folder` itself, as
 * the trust dialog would: `projects[<real path>].hasTrustDialogAccepted`
 * (FE-101).
 *
 * Only that one key changes; the rest of the project's record, and of the
 * file, is written back as it was read. Ancestors are never touched.
 *
 * NOTE: Only on the user's click. Trust lets the repo's `.claude` hooks,
 * `env` and `apiKeyHelper` run as the user (FE-77/D3).
 *
 * @throws When the file is not a JSON object: it is never overwritten.
 */
export async function setClaudeTrust(
  folder: string,
  on: boolean,
  claudeJson = claudeJsonFor(),
): Promise<void> {
  const real = await realpath(folder).catch(() => resolve(folder));
  await updateConfigFile(
    claudeJson,
    (text) => {
      const parsed: unknown = text?.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(
          `${claudeJson} is not a JSON object. Fix it, then try again — Lanework will not overwrite it.`,
        );
      const json = parsed as { projects?: unknown };
      const projects =
        json.projects && typeof json.projects === "object"
          ? (json.projects as Record<string, unknown>)
          : {};
      // The folder's records as Claude filed them, else a new one under the
      // real path, which is the cwd Claude itself sees.
      const there = [...new Set([resolve(folder), real])].filter((key) =>
        Object.hasOwn(projects, key),
      );
      const keys = there.length ? there : [real];
      const next = { ...projects };
      for (const key of keys) {
        const was = projects[key];
        const project =
          was && typeof was === "object"
            ? (was as Record<string, unknown>)
            : {};
        next[key] = { ...project, hasTrustDialogAccepted: on };
      }
      if (
        keys.every(
          (key) =>
            (projects[key] as { hasTrustDialogAccepted?: unknown } | undefined)
              ?.hasTrustDialogAccepted === on,
        )
      )
        return null;
      return `${JSON.stringify({ ...json, projects: next }, null, 2)}\n`;
    },
    0o600,
  );
}
