import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gitReadOut } from "./runner";

/**
 * Whether a folder's `.git` asks git to run the repository's own programs
 * (FE-77, D6 / GAP-01).
 *
 * The app reads a linked folder on its own: status on project open, a log
 * line, a diff. A repository someone cloned can make those reads run code it
 * supplies, through its local config (a clean filter, `core.fsmonitor`, a
 * diff driver, `gpg.program`) or an executable hook. Before the first
 * automatic read, {@link scanRepoTrust} lists every such entry so the user can
 * say whether this folder may run them.
 *
 * NOTE: The scan itself runs nothing the repository controls.
 *
 * - `git rev-parse` and `git config` read config files and never start
 *   fsmonitor, a filter, a diff driver or a hook: none of those fire without
 *   touching the index or the work tree. They also go through
 *   {@link gitReadOut}, which turns fsmonitor and hooks off anyway.
 * - Hooks are listed with `readdir` and `stat`, never executed.
 *
 * Only the repository's own config counts: `local` and `worktree` scope,
 * including any file a local `include.path` pulls in. The user's global
 * `filter.lfs` or `gpg.ssh.program` is the user's choice, not the
 * repository's, and must not make every folder look risky.
 */

export type TrustFinding =
  | { kind: "config"; key: string; value: string }
  | { kind: "hook"; name: string };

export interface RepoTrustScan {
  /** True when at least one finding is present. */
  risky: boolean;
  findings: TrustFinding[];
  /**
   * The repository's common git dir (where hooks and the shared config live);
   * null when the folder is not a git repository git will open.
   */
  gitDir: string | null;
}

/** Values of `core.fsmonitor` that mean "off". */
const OFF = new Set(["false", "no", "off", "0", ""]);

/**
 * Whether a local config key names a program git may run during a read.
 *
 * `key` is as `git config --list` prints it: section and variable lower-case,
 * a subsection as written.
 *
 * - `filter.*`: clean/smudge/process run on stat-dirty reads and checkout.
 * - `core.fsmonitor`: any value but off. `true` starts git's own daemon,
 *   anything else is a command from the repository.
 * - `core.hooksPath`: moves hooks somewhere the hook listing does not look.
 * - `core.sshCommand`: runs on fetch.
 * - `gpg.*`: `gpg.program`, `gpg.<format>.program`, and what selects them.
 * - `diff.external`, `diff.<driver>.command`, `diff.<driver>.textconv`: run
 *   when a diff is drawn. `textconv` is beyond the card's list; it runs on
 *   the same diff reads, so it is listed with the others.
 */
function risky(key: string, value: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("filter.")) return true;
  if (lower === "core.fsmonitor") return !OFF.has(value.trim().toLowerCase());
  if (lower === "core.hookspath") return true;
  if (lower === "core.sshcommand") return true;
  if (lower.startsWith("gpg.")) return true;
  if (lower === "diff.external") return true;
  if (
    lower.startsWith("diff.") &&
    (lower.endsWith(".command") || lower.endsWith(".textconv"))
  )
    return true;
  return false;
}

/**
 * The common git dir of `folder`, or null when git will not open it.
 *
 * `--git-common-dir`, not `--git-dir`: in a linked worktree `.git` is a file
 * that points at `<main>/.git/worktrees/<name>`, and the hooks and the shared
 * config live in `<main>/.git`. git prints the path relative to the cwd or
 * absolute, so it is resolved against `folder`.
 */
async function commonDir(folder: string): Promise<string | null> {
  try {
    const raw = await gitReadOut(folder, ["rev-parse", "--git-common-dir"], {
      timeout: 5_000,
    });
    const dir = raw.trim();
    return dir ? resolve(folder, dir) : null;
  } catch {
    // Not a repository, git missing, or git refused it (safe.directory). In
    // every case no other read of this folder will run either.
    return null;
  }
}

/** Local and worktree config entries that name a program. */
async function configFindings(folder: string): Promise<TrustFinding[]> {
  // `--list --show-scope` over every file, rather than `--local`: `--local`
  // skips `include.path` unless asked, and leaves out `config.worktree`.
  // Filtering by scope keeps global and system out.
  const raw = await gitReadOut(
    folder,
    ["config", "--list", "--show-scope", "-z"],
    {
      timeout: 5_000,
    },
  );
  const found: TrustFinding[] = [];
  // -z: `<scope>\0<key>\n<value>\0`, the value absent (no `\n`) for a bare
  // boolean key.
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    if (scope !== "local" && scope !== "worktree") continue;
    const entry = parts[i + 1];
    const cut = entry.indexOf("\n");
    const key = cut < 0 ? entry : entry.slice(0, cut);
    const value = cut < 0 ? "true" : entry.slice(cut + 1);
    if (risky(key, value)) found.push({ kind: "config", key, value });
  }
  return found;
}

/**
 * Hooks git would run: files in `<common dir>/hooks` that are executable.
 *
 * - `*.sample` is what `git init` writes, and git never runs it.
 * - `stat`, not `lstat`: a symlinked hook runs as its target.
 * - On Windows there is no execute bit and git runs any hook file it finds,
 *   so every non-sample file counts.
 */
async function hookFindings(dir: string): Promise<TrustFinding[]> {
  const hooks = join(dir, "hooks");
  const names = await readdir(hooks).catch(() => [] as string[]);
  const found: TrustFinding[] = [];
  for (const name of names.sort()) {
    if (name.endsWith(".sample")) continue;
    const info = await stat(join(hooks, name)).catch(() => null);
    if (!info?.isFile()) continue;
    if (process.platform !== "win32" && (info.mode & 0o111) === 0) continue;
    found.push({ kind: "hook", name });
  }
  return found;
}

/**
 * List what in `folder`'s `.git` would run code during the app's reads.
 *
 * A folder that is not a repository is not risky: git will not read it.
 *
 * @throws {GitMissingError} Never; a missing git reads as "not a repository".
 */
export async function scanRepoTrust(folder: string): Promise<RepoTrustScan> {
  const dir = await commonDir(folder);
  if (!dir) return { risky: false, findings: [], gitDir: null };
  const [config, hooks] = await Promise.all([
    configFindings(folder).catch(() => [] as TrustFinding[]),
    hookFindings(dir),
  ]);
  const findings = [...config, ...hooks];
  return { risky: findings.length > 0, findings, gitDir: dir };
}

/**
 * A stable string for a scan's findings.
 *
 * An answer is remembered against it, so a hook or a filter added after the
 * user trusted the folder asks again.
 */
export function trustFingerprint(findings: TrustFinding[]): string {
  return findings
    .map((f) =>
      f.kind === "hook" ? `hook:${f.name}` : `config:${f.key}=${f.value}`,
    )
    .sort()
    .join("\n");
}

/** The user's answer for one folder. */
export type TrustAnswer = "trusted" | "restricted";

export interface RememberedTrust {
  answer: TrustAnswer;
  /** {@link trustFingerprint} of the findings the user answered. */
  fingerprint: string;
}

/** What to do with a folder before its first automatic read. */
export type TrustDecision =
  | { kind: "run" } // nothing risky, or trusted with these exact findings
  | { kind: "restricted" } // the user said no to these exact findings
  | { kind: "ask"; scan: RepoTrustScan };

/**
 * Remembered answers, in memory (FE-182).
 *
 * What the user answers is the repository's own config and hooks, which live
 * in its common git dir and are shared by every folder of it (a subfolder, a
 * linked worktree). So an answer is kept per repository and findings
 * fingerprint, under `repo:<git dir>#<hash>`: a new folder of a trusted
 * repository reads without asking, a hook or filter added later asks again,
 * and a worktree with config of its own asks once without taking the main
 * checkout's answer from it.
 *
 * Answers an earlier version kept by folder path still count: a folder's own
 * entry, or its repository root's, answers for it when the findings are the
 * same, and is filed under the repository from then on.
 *
 * Electron-free: the caller owns where answers are kept. Seed it with
 * `initial` and persist from `onChange`, which receives every answer.
 */
export class TrustStore {
  private readonly answers = new Map<string, RememberedTrust>();

  constructor(
    initial: Record<string, RememberedTrust> = {},
    private readonly onChange?: (all: Record<string, RememberedTrust>) => void,
  ) {
    for (const [key, value] of Object.entries(initial))
      this.answers.set(key.startsWith(REPO_PREFIX) ? key : resolve(key), value);
  }

  /** The key one repository's answer for one set of findings is filed under. */
  private repoKey(scan: RepoTrustScan): string | null {
    if (!scan.gitDir) return null;
    const hash = createHash("sha1")
      .update(trustFingerprint(scan.findings))
      .digest("hex")
      .slice(0, 16);
    return `${REPO_PREFIX}${resolve(scan.gitDir)}#${hash}`;
  }

  /**
   * The folder-path keys an earlier version may have answered under: the
   * folder itself and the repository's main work tree root.
   */
  private legacyKeys(folder: string, scan: RepoTrustScan): string[] {
    const keys = [resolve(folder)];
    if (scan.gitDir && basename(scan.gitDir) === ".git")
      keys.push(resolve(dirname(scan.gitDir)));
    return [...new Set(keys)];
  }

  /**
   * The answer for `folder`'s repository and these findings, or none.
   *
   * A match under a folder path is filed under the repository, so the next
   * lookup (from any folder of it) finds it there.
   */
  lookup(folder: string, scan: RepoTrustScan): RememberedTrust | undefined {
    const key = this.repoKey(scan);
    const fingerprint = trustFingerprint(scan.findings);
    if (key) {
      const known = this.answers.get(key);
      if (known) return known;
    }
    for (const legacy of this.legacyKeys(folder, scan)) {
      const known = this.answers.get(legacy);
      if (known && known.fingerprint === fingerprint) {
        if (key) {
          this.answers.set(key, known);
          this.onChange?.(this.toJSON());
        }
        return known;
      }
    }
    return undefined;
  }

  /** Remember `answer` for the findings in `scan`, for the whole repository. */
  set(folder: string, answer: TrustAnswer, scan: RepoTrustScan): void {
    const key = this.repoKey(scan) ?? resolve(folder);
    this.answers.set(key, {
      answer,
      fingerprint: trustFingerprint(scan.findings),
    });
    this.onChange?.(this.toJSON());
  }

  /**
   * Forget the answer for `folder`'s repository and these findings, and any
   * a folder path still holds for them, so the next read asks again.
   *
   * @param scan The folder's scan; without one only its own folder-path
   *   entry goes.
   */
  forget(folder: string, scan?: RepoTrustScan | null): void {
    let changed = false;
    const drop = (key: string | null) => {
      if (key && this.answers.delete(key)) changed = true;
    };
    if (!scan) drop(resolve(folder));
    else {
      drop(this.repoKey(scan));
      for (const legacy of this.legacyKeys(folder, scan)) drop(legacy);
    }
    if (changed) this.onChange?.(this.toJSON());
  }

  /** Scan `folder` and weigh it against the remembered answer. */
  async decide(folder: string): Promise<TrustDecision> {
    const scan = await scanRepoTrust(folder);
    if (!scan.risky) return { kind: "run" };
    const known = this.lookup(folder, scan);
    if (known)
      return known.answer === "trusted"
        ? { kind: "run" }
        : { kind: "restricted" };
    return { kind: "ask", scan };
  }

  toJSON(): Record<string, RememberedTrust> {
    return Object.fromEntries(this.answers);
  }
}

/** Marks a key filed under a repository rather than a folder path. */
const REPO_PREFIX = "repo:";
