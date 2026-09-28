import { execFile } from "node:child_process";
import { open, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type BranchList,
  type BranchState,
  type CommitChange,
  type CommitHistory,
  type CommitMode,
  type CommitSummary,
  type FileSide,
  HISTORY_PAGE,
  patchStats,
  type StagedState,
  type SyncAction,
  type WorktreeFile,
  type WorktreeFileStatus,
  type WorktreePatch,
  type WorktreeState,
} from "../../../shared/worktree";

/**
 * The project's local repository, driven through the `git` CLI (FE-22).
 *
 * ⚠️ THE ONE MODULE IN THIS APP THAT WRITES TO A USER'S FOLDER. Everything else
 * that reads a project folder — `remote.ts`, `local-folder.ts` — is read-only by
 * rule, and stays that way. Staging, committing and throwing a change away were
 * approved on FE-22 (D1), and they live HERE so that the rule has exactly one
 * exception with one address. A write anywhere else is still a bug.
 *
 * ⚠️ `execFile`, never `exec`: no shell, so a path with a space, a quote or a
 * `;` in it is an argument rather than syntax. Every path a command receives
 * comes after `--`, so one that starts with a dash is a file, not a flag.
 *
 * ⚠️ Paths are checked against a FRESH status before anything acts on them
 * (`changed`). The renderer can only name a file that git itself just called
 * changed, which is what keeps `restore` — the one call that deletes — from
 * being a way to delete anything else in the folder.
 */

/** The empty tree, for diffing a repository that has no commit yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A commit id as a renderer may name one. Hex, and nothing else. */
const SHA = /^[0-9a-f]{7,64}$/i;

/** Untracked files read to count and show them. Beyond this they are listed only. */
const MAX_UNTRACKED_READS = 200;

/** One file read in full for the viewer. A diff is not a place for more. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How much output one `git` call may produce before it is a refusal. */
const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Flags every call carries.
 *
 * ⚠️ `core.quotepath=false` so a non-ASCII filename comes back as itself rather
 * than as octal escapes — which would not match the path on disk, nor the path
 * in the patch. `color.ui=never` and `--no-pager` because nobody reads this
 * output but a parser.
 */
const BASE = [
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=never",
  "--no-pager",
];

export class GitMissingError extends Error {}

interface RunResult {
  stdout: string;
  code: number;
}

function run(
  cwd: string,
  args: string[],
  options: { ok?: number[]; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const ok = options.ok ?? [0];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...BASE, ...args],
      {
        cwd,
        timeout: options.timeout ?? 15_000,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        encoding: "utf8",
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, code: 0 });
        const code = typeof error.code === "number" ? error.code : null;
        if (error.code === "ENOENT")
          return reject(new GitMissingError("git is not installed."));
        if (code !== null && ok.includes(code))
          return resolve({ stdout, code });
        // ⚠️ git's own words, trimmed to what fits a toast. "Author identity
        // unknown" or a pre-commit hook's output is the whole explanation; a
        // generic "commit failed" would send somebody to a terminal to find it.
        const said = (stderr || stdout || error.message).trim();
        reject(new Error(said.split("\n").slice(-6).join("\n").slice(0, 800)));
      },
    );
  });
}

async function out(cwd: string, args: string[]): Promise<string> {
  return (await run(cwd, args)).stdout;
}

/**
 * Where the repository is, or which of the ways to have none this is.
 *
 * ⚠️ The TOP LEVEL, not the linked folder. A project linked to a subfolder of a
 * repository still has the whole repository's index, and a status read from a
 * subfolder would print paths no `git add` from the top could find.
 */
export async function locate(
  folder: string | null,
): Promise<
  | { kind: "none" }
  | { kind: "missing"; path: string }
  | { kind: "not-repo"; path: string }
  | { kind: "no-git" }
  | { kind: "ready"; top: string }
> {
  if (!folder) return { kind: "none" };
  const found = await stat(folder).catch(() => null);
  if (!found?.isDirectory()) return { kind: "missing", path: folder };
  try {
    const top = (await out(folder, ["rev-parse", "--show-toplevel"])).trim();
    return top ? { kind: "ready", top } : { kind: "not-repo", path: folder };
  } catch (error) {
    if (error instanceof GitMissingError) return { kind: "no-git" };
    return { kind: "not-repo", path: folder };
  }
}

async function hasHead(top: string): Promise<boolean> {
  const { code } = await run(top, ["rev-parse", "--verify", "-q", "HEAD"], {
    ok: [1],
  });
  return code === 0;
}

interface RawEntry {
  path: string;
  previousPath: string | null;
  status: WorktreeFileStatus;
  staged: StagedState;
}

function stagedOf(x: string, y: string): StagedState {
  if (x === ".") return "none";
  return y === "." ? "full" : "partial";
}

function statusOf(x: string, y: string): WorktreeFileStatus {
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

/**
 * `git status --porcelain=v2 -z`, read.
 *
 * ⚠️ v2 and `-z` because both are the forms git promises not to change, and
 * because NUL is the one byte a path cannot contain. Splitting v1 output on
 * spaces breaks on the first filename with one.
 */
function parseStatus(raw: string): {
  branch: BranchState;
  entries: RawEntry[];
} {
  const branch: BranchState = { name: null, ahead: null, behind: null };
  const entries: RawEntry[] = [];
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const name = line.slice(14);
      branch.name = name === "(detached)" ? null : name;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      entries.push({
        path: parts.slice(8).join(" "),
        previousPath: null,
        status: statusOf(xy[0], xy[1]),
        staged: stagedOf(xy[0], xy[1]),
      });
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // ⚠️ The ORIGINAL path is the next NUL-separated token, not part of this
      // one — which is why this loop indexes rather than maps.
      const previous = tokens[++i] ?? null;
      entries.push({
        path: parts.slice(9).join(" "),
        previousPath: previous,
        status: "renamed",
        staged: stagedOf(xy[0], xy[1]),
      });
    } else if (line.startsWith("u ")) {
      entries.push({
        path: line.split(" ").slice(10).join(" "),
        previousPath: null,
        status: "conflicted",
        staged: "none",
      });
    } else if (line.startsWith("? ")) {
      entries.push({
        path: line.slice(2),
        previousPath: null,
        status: "untracked",
        staged: "none",
      });
    }
  }
  return { branch, entries };
}

/** `--numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` on a rename. */
function parseNumstat(
  raw: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const map = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const [add, del, path] = token.split("\t");
    let name = path ?? "";
    if (name === "") {
      i++; // the old name
      name = tokens[++i] ?? "";
    }
    const binary = add === "-" && del === "-";
    map.set(name, {
      additions: binary ? 0 : Number(add) || 0,
      deletions: binary ? 0 : Number(del) || 0,
      binary,
    });
  }
  return map;
}

/**
 * A path the repository names, resolved on disk and proven to be inside it.
 *
 * ⚠️ `realpath` on the PARENT, so a symlinked directory that points out of the
 * repository is caught — and the file itself is not followed, because deleting
 * an untracked symlink must delete the link, never what it points at.
 */
async function inside(top: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error("That file is not in this repository.");
  const root = await realpath(top);
  const full = join(root, path);
  const parent = await realpath(join(full, "..")).catch(() => null);
  if (!parent) throw new Error("That file is not in this repository.");
  const rel = relative(root, parent);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("That file is not in this repository.");
  return join(parent, full.slice(full.lastIndexOf(sep) + 1));
}

/** A file's text, or null when it is binary, too big, or not there. */
async function readText(full: string): Promise<string | null> {
  const handle = await open(full, "r").catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    // The same test git uses: a NUL in the content means binary.
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

async function readEntries(top: string) {
  const [statusRaw, head] = await Promise.all([
    out(top, [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]),
    hasHead(top),
  ]);
  return { ...parseStatus(statusRaw), head };
}

function toCommit(record: string): CommitSummary | null {
  const [sha, shortSha, authorName, authorEmail, authoredAt, subject, body] =
    record.split("\x1f");
  if (!sha || !shortSha) return null;
  return {
    sha,
    shortSha,
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    authoredAt: authoredAt ?? "",
    subject: subject ?? "",
    body: (body ?? "").trim(),
  };
}

const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";

async function headCommit(top: string, head: boolean) {
  if (!head) return null;
  const raw = await out(top, ["log", "-1", LOG_FORMAT]);
  return toCommit(raw.split("\x1e")[0]?.replace(/^\n/, "") ?? "");
}

export async function status(top: string): Promise<WorktreeState> {
  const { branch, entries, head } = await readEntries(top);
  const [numstat, last, names] = await Promise.all([
    entries.some((entry) => entry.status !== "untracked")
      ? out(top, [
          "diff",
          head ? "HEAD" : EMPTY_TREE,
          "--numstat",
          "-z",
          "-M",
          "--no-ext-diff",
        ]).then(parseNumstat)
      : Promise.resolve(new Map()),
    headCommit(top, head),
    remotes(top),
  ]);
  const ahead = head ? await unpushedCount(top, names) : 0;

  let reads = 0;
  const files: WorktreeFile[] = [];
  for (const entry of entries) {
    let counts = numstat.get(entry.path) ?? {
      additions: 0,
      deletions: 0,
      binary: false,
    };
    if (entry.status === "untracked" && reads < MAX_UNTRACKED_READS) {
      reads++;
      const text = await readText(join(top, entry.path));
      counts =
        text === null
          ? { additions: 0, deletions: 0, binary: true }
          : { additions: lineCount(text), deletions: 0, binary: false };
    }
    files.push({ ...entry, ...counts });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    kind: "ready",
    folder: top,
    branch,
    files,
    head: last,
    remotes: names,
    unpushed: ahead,
  };
}

/**
 * Every change as one patch: tracked against HEAD, then each untracked file
 * against nothing.
 *
 * ⚠️ Against HEAD, so staged and unstaged read as one change. That is what the
 * list beside it shows — one row per file — and the checkbox, not the diff, is
 * where the split between index and working tree is visible.
 */
export async function patch(top: string): Promise<WorktreePatch> {
  const { entries, head } = await readEntries(top);
  const parts: string[] = [];
  if (entries.some((entry) => entry.status !== "untracked"))
    parts.push(
      await out(top, [
        "diff",
        head ? "HEAD" : EMPTY_TREE,
        "-M",
        "--no-ext-diff",
        "--no-textconv",
      ]),
    );
  const untracked = entries.filter((entry) => entry.status === "untracked");
  for (const entry of untracked.slice(0, MAX_UNTRACKED_READS)) {
    // ⚠️ Exit 1 is the ANSWER here — `--no-index` reports "these differ" the
    // way `diff(1)` does — so it is accepted rather than thrown.
    const { stdout } = await run(
      top,
      ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", entry.path],
      { ok: [1] },
    );
    parts.push(stdout);
  }
  return {
    patch: parts.filter(Boolean).join(""),
    skipped: Math.max(0, untracked.length - MAX_UNTRACKED_READS),
  };
}

/**
 * The files a renderer named, checked against what git says changed NOW.
 *
 * ⚠️ Answers the entries, not the paths, so the caller acts on git's own record
 * — its status, its rename source — rather than on anything the renderer sent.
 */
async function changed(top: string, paths: string[]) {
  const { entries, head } = await readEntries(top);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const picked: RawEntry[] = [];
  for (const path of new Set(paths)) {
    const entry = byPath.get(path);
    if (!entry)
      throw new Error(
        `${path} has no change to act on. Refresh and try again.`,
      );
    picked.push(entry);
  }
  return { picked, head };
}

function withSources(entries: RawEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.previousPath ? [entry.path, entry.previousPath] : [entry.path],
  );
}

export async function stage(top: string, paths: string[]): Promise<void> {
  const { picked } = await changed(top, paths);
  if (!picked.length) return;
  // `-A` so a deleted file is staged as a deletion rather than refused.
  await out(top, ["add", "-A", "--", ...withSources(picked)]);
}

export async function unstage(top: string, paths: string[]): Promise<void> {
  const { picked, head } = await changed(top, paths);
  if (!picked.length) return;
  const targets = withSources(picked);
  // ⚠️ No HEAD, no `restore --staged`: there is nothing to restore the index
  // FROM in a repository with no commit, so the file leaves the index instead.
  if (head) await out(top, ["restore", "--staged", "--", ...targets]);
  else await out(top, ["rm", "--cached", "-r", "-q", "--", ...targets]);
}

/**
 * Throw changes away, in the index and on disk.
 *
 * ⚠️ Three kinds of file, three different undos. A file HEAD knows is put back
 * as HEAD has it. A file HEAD does not know — new in the index, or untracked —
 * has no earlier version to go back to, so undoing it means DELETING it; the
 * confirmation the renderer shows says exactly that (FE-22/D8).
 */
export async function restore(top: string, paths: string[]): Promise<void> {
  const { picked, head } = await changed(top, paths);
  const fromHead: string[] = [];
  const dropFromIndex: string[] = [];
  const remove: string[] = [];
  for (const entry of picked) {
    if (entry.status === "untracked") remove.push(entry.path);
    else if (!head || entry.status === "added") {
      dropFromIndex.push(entry.path);
      remove.push(entry.path);
    } else if (entry.status === "renamed" && entry.previousPath) {
      fromHead.push(entry.previousPath);
      dropFromIndex.push(entry.path);
      remove.push(entry.path);
    } else fromHead.push(entry.path);
  }
  if (fromHead.length)
    await out(top, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...fromHead,
    ]);
  if (dropFromIndex.length)
    await out(top, ["rm", "--cached", "-f", "-q", "--", ...dropFromIndex]);
  for (const path of remove)
    await rm(await inside(top, path), { force: true, recursive: false });
}

export async function commit(
  top: string,
  message: string,
  mode: CommitMode,
): Promise<void> {
  // ⚠️ `-m` as ONE argument, not a temp file or stdin: execFile hands it to git
  // untouched, newlines included, and nothing is left on disk afterwards.
  //
  // ⚠️ A long timeout. A pre-commit hook — a formatter, a type check — runs
  // inside this call, and killing it at fifteen seconds would leave a commit
  // half-made by a hook that did not get to finish.
  await run(
    top,
    ["commit", ...(mode === "tracked" ? ["-a"] : []), "-m", message],
    { timeout: 180_000 },
  );
}

/**
 * The environment every call that talks to a remote runs in.
 *
 * ⚠️ Never a prompt. There is no terminal behind this process, so a git that
 * asked for a password — or ssh asking to trust a host — would wait for an
 * answer until the timeout. Failing says what is wrong instead. `GIT_EDITOR`
 * for the same reason: a pull that merges must not open an editor nobody sees.
 */
function networkEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

export async function remotes(top: string): Promise<string[]> {
  return (await out(top, ["remote"]))
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Fetch, pull or push (the Changes screen's sync button).
 *
 * ⚠️ A remote the renderer names is checked against a FRESH `git remote`, so it
 * can only ever be one of this repository's remotes — never a URL, a path, or
 * a string that starts with a dash.
 *
 * ⚠️ A branch with no upstream is pushed with `-u` to the named remote (or
 * `origin`, or the only one there is), so its first push also sets where later
 * pulls and pushes go. With an upstream, a plain push follows the user's own
 * `push.default`. Pull says `--no-rebase` or `--rebase` out loud, because the
 * menu names which one it is and `pull.rebase` must not make it the other.
 */
export async function sync(
  top: string,
  action: SyncAction,
  remote: string | null,
): Promise<void> {
  const names = await remotes(top);
  if (!names.length) throw new Error("This repository has no remote.");
  if (remote !== null && !names.includes(remote))
    throw new Error(`${remote} is not a remote of this repository.`);
  const env = networkEnv();

  if (action === "fetch") {
    await run(top, ["fetch", "--prune", ...(remote ? [remote] : [])], {
      timeout: 90_000,
      env,
    });
    return;
  }

  // ⚠️ A long timeout for the rest: a pull runs merge hooks, a push runs the
  // pre-push hook, and killing either halfway leaves the branch in between.
  if (action === "pull" || action === "pull-rebase") {
    await run(
      top,
      ["pull", action === "pull-rebase" ? "--rebase" : "--no-rebase"],
      { timeout: 180_000, env },
    );
    return;
  }

  const branch = await run(
    top,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      ok: [1],
    },
  );
  if (branch.code !== 0) throw new Error("Check out a branch to push it.");
  const upstream = await run(
    top,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { ok: [128] },
  );
  const force = action === "force-push" ? ["--force-with-lease"] : [];
  const args =
    upstream.code === 0 && remote === null
      ? ["push", ...force]
      : [
          "push",
          ...force,
          ...(upstream.code === 0 ? [] : ["--set-upstream"]),
          remote ?? (names.includes("origin") ? "origin" : names[0]),
          "HEAD",
        ];
  await run(top, args, { timeout: 180_000, env });
}

/** The most unpushed commits `log` looks for; past it, rows go unmarked. */
const MAX_UNPUSHED = 5_000;

/**
 * Commits on HEAD that no remote-tracking branch has.
 *
 * ⚠️ `--not --remotes`, not `@{u}..HEAD`: a branch pushed without `-u` has no
 * upstream, and every one of its commits would then read as unpushed. And not
 * the branch's `ahead` count either — with a merge in the way, the unpushed
 * commits are not the first N rows of the log.
 *
 * ⚠️ Empty when the repository has no remote: with nowhere to push, "not
 * pushed" would mark every commit and say nothing.
 */
async function unpushed(top: string): Promise<Set<string>> {
  if (!(await remotes(top)).length) return new Set();
  const raw = await out(top, [
    "rev-list",
    `--max-count=${MAX_UNPUSHED}`,
    "HEAD",
    "--not",
    "--remotes",
  ]);
  return new Set(raw.split("\n").filter(Boolean));
}

/**
 * How many commits `unpushed` would mark, for the rail's History badge — the
 * same rule, so the badge and the ↑ marks never disagree.
 */
async function unpushedCount(top: string, names: string[]): Promise<number> {
  if (!names.length) return 0;
  const raw = await out(top, [
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    "--remotes",
  ]);
  return Number.parseInt(raw.trim(), 10) || 0;
}

export async function log(top: string, skip: number): Promise<CommitHistory> {
  if (!(await hasHead(top))) return { commits: [], more: false };
  const [raw, ahead] = await Promise.all([
    out(top, [
      "log",
      `--max-count=${HISTORY_PAGE + 1}`,
      `--skip=${skip}`,
      LOG_FORMAT,
    ]),
    unpushed(top),
  ]);
  const commits = raw
    .split("\x1e")
    .map((record) => toCommit(record.replace(/^\n/, "")))
    .filter((entry): entry is CommitSummary => entry !== null)
    .map((commit) =>
      ahead.has(commit.sha) ? { ...commit, unpushed: true } : commit,
    );
  return {
    commits: commits.slice(0, HISTORY_PAGE),
    more: commits.length > HISTORY_PAGE,
  };
}

export async function show(top: string, sha: string): Promise<CommitChange> {
  if (!SHA.test(sha)) throw new Error("That is not a valid commit.");
  const raw = await out(top, ["log", "-1", LOG_FORMAT, sha]);
  const summary = toCommit(raw.split("\x1e")[0]?.replace(/^\n/, "") ?? "");
  if (!summary) throw new Error("That commit is not in this repository.");
  // ⚠️ Against the FIRST parent. A merge shown against all of its parents is a
  // combined diff, which is a format the viewer cannot draw; against its first
  // parent it is "what this merge brought in", which is the question.
  const text = await out(top, [
    "show",
    "--format=",
    "-M",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-merges=first-parent",
    summary.sha,
  ]);
  const stats = patchStats(text);
  const files = [...stats].map(([path, counts]) => ({
    path,
    previousPath: null,
    ...counts,
  }));
  return { commit: summary, patch: text, files };
}

/**
 * One side of one file, for expanding the lines a diff leaves out.
 *
 * ⚠️ A revision is `HEAD`, a sha, or a sha's first parent (`<sha>^`) — the
 * shapes the viewer needs, and none that `git show` could read as an option.
 */
export async function fileText(
  top: string,
  path: string,
  side: FileSide,
): Promise<string | null> {
  if (side.kind === "worktree") return readText(await inside(top, path));
  const rev = side.rev;
  const base = rev.endsWith("^") ? rev.slice(0, -1) : rev;
  if (base !== "HEAD" && !SHA.test(base))
    throw new Error("That is not a valid commit.");
  if (!path || isAbsolute(path) || path.split("/").includes(".."))
    throw new Error("That file is not in this repository.");
  const { stdout, code } = await run(top, ["show", `${rev}:${path}`], {
    ok: [128],
  });
  if (code !== 0) return null;
  if (stdout.length > MAX_FILE_BYTES || stdout.includes("\0")) return null;
  return stdout;
}

/**
 * Local and remote branches, newest commit first.
 *
 * ⚠️ `for-each-ref`, not `branch -a`: its output is a format this code chose,
 * not one meant for a person to read, so there is no `* ` marker or `->` arrow
 * to strip off.
 */
export async function branches(top: string): Promise<BranchList> {
  const [refs, head] = await Promise.all([
    out(top, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ]),
    run(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [1] }),
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of refs.split("\n")) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice(11));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
      remote.push(ref.slice(13));
  }
  const mine = new Set(local);
  return {
    current: head.code === 0 ? head.stdout.trim() || null : null,
    local,
    remote: remote.filter(
      (name) => !mine.has(name.slice(name.indexOf("/") + 1)),
    ),
  };
}

/**
 * Switch to a branch the list above just named.
 *
 * ⚠️ Checked against a FRESH list, so the renderer can only name a branch that
 * exists — never a sha, a path, or a string that starts with a dash. A remote
 * branch is switched to with `--track`, which creates the local branch that
 * follows it; the remote-tracking ref itself is never checked out detached.
 *
 * ⚠️ No `--force`, no `--discard-changes`. Uncommitted work that the other
 * branch would overwrite makes git refuse, and that is the right outcome.
 */
export async function switchBranch(top: string, name: string): Promise<void> {
  const list = await branches(top);
  if (list.local.includes(name)) {
    await run(top, ["switch", name], { timeout: 60_000 });
    return;
  }
  if (list.remote.includes(name)) {
    await run(top, ["switch", "--track", name], { timeout: 60_000 });
    return;
  }
  throw new Error(`${name} is not a branch in this repository.`);
}
