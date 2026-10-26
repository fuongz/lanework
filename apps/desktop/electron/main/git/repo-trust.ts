import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
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
 * Remembered answers by folder, in memory.
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
    for (const [folder, value] of Object.entries(initial))
      this.answers.set(resolve(folder), value);
  }

  get(folder: string): RememberedTrust | undefined {
    return this.answers.get(resolve(folder));
  }

  /** Remember `answer` for the findings in `scan`. */
  set(folder: string, answer: TrustAnswer, scan: RepoTrustScan): void {
    this.answers.set(resolve(folder), {
      answer,
      fingerprint: trustFingerprint(scan.findings),
    });
    this.onChange?.(this.toJSON());
  }

  forget(folder: string): void {
    if (this.answers.delete(resolve(folder))) this.onChange?.(this.toJSON());
  }

  /** Scan `folder` and weigh it against the remembered answer. */
  async decide(folder: string): Promise<TrustDecision> {
    const scan = await scanRepoTrust(folder);
    if (!scan.risky) return { kind: "run" };
    const known = this.get(folder);
    if (known && known.fingerprint === trustFingerprint(scan.findings))
      return known.answer === "trusted"
        ? { kind: "run" }
        : { kind: "restricted" };
    return { kind: "ask", scan };
  }

  toJSON(): Record<string, RememberedTrust> {
    return Object.fromEntries(this.answers);
  }
}
