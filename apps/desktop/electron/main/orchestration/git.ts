// A worker's own checkout (FE-87): a git worktree on a branch of its own,
// seeded with the lead checkout's files as they are now, and merged back file
// by file when the lead accepts it.
//
// - The worktree starts at the main checkout's HEAD, then takes every file
//   the user has changed or added there but not committed, so a worker sees
//   what the lead sees. A "baseline" commit on the worker's branch records
//   that state: everything after it is the worker's.
// - Review merges each changed file three ways: the baseline, the lead
//   checkout now, the worker's. Nothing is written until every file merges;
//   one conflict and the main checkout is left as it was.
//
// Every git call runs with the read flags (`../git/runner`): no hooks, no
// fsmonitor, no signature program. The baseline commit is the app's own
// bookkeeping on a scratch branch, never the user's history.
//
// NOTE: A worker can write its worktree's `.git` file. Git follows it, so a
// worker that pointed it at a folder of its own (with a clean filter in its
// config) would run code in this process on the next `git add` (FE-89/D8).
// So every call on a worktree names its git dir and work tree explicitly
// (`WorkerTree`): the admin dir main found under the main checkout's
// `.git/worktrees/` when it made the worktree. Before each one, the `.git`
// file must still point there, or the call throws `WorktreePointerError`.
//
// Nothing here imports Electron.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_OUTPUT, READ_FLAGS } from "../git/runner";
import { resolvedPath, within } from "./scopes";

/** Flags for the app's own commits on a worker branch. */
const COMMIT_FLAGS = [
  "-c",
  "user.name=Lanework",
  "-c",
  "user.email=orchestration@lanework.invalid",
  "-c",
  "commit.gpgsign=false",
];

interface Run {
  stdout: Buffer;
  code: number;
}

/** The app's env, without anything that would point git elsewhere. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
  ])
    delete env[name];
  return env;
}

/**
 * Run `git` with the read flags, its output as bytes.
 *
 * @throws With git's last lines when it exits with a code not in `ok`.
 */
function git(
  cwd: string,
  args: string[],
  ok: number[] = [0],
  timeout = 60_000,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...READ_FLAGS, ...args],
      {
        cwd,
        timeout,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        encoding: "buffer",
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, code: 0 });
        const code = typeof error.code === "number" ? error.code : null;
        if (code !== null && ok.includes(code))
          return resolve({ stdout, code });
        const said = (stderr.toString() || error.message).trim();
        reject(new Error(said.split("\n").slice(-4).join("\n").slice(0, 600)));
      },
    );
  });
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.toString("utf8");
}

/** A worker's worktree, and the git dir main computed for it. */
export interface WorkerTree {
  /** The worktree's folder, resolved. */
  path: string;
  /** Its admin dir under the main checkout's `.git/worktrees/`, resolved. */
  gitDir: string;
}

/** The worktree's `.git` file no longer points at its own admin dir. */
export class WorktreePointerError extends Error {
  override name = "WorktreePointerError";
}

/** Where a `.git` file points, resolved; null when it is not a plain one. */
async function pointerOf(tree: string): Promise<string | null> {
  const dotGit = join(tree, ".git");
  const info = await lstat(dotGit).catch(() => null);
  if (!info?.isFile() || info.size > 4096) return null;
  const match = /^gitdir: (.+?)\s*$/.exec(await readFile(dotGit, "utf8"));
  if (!match?.[1]) return null;
  return realpath(resolve(tree, match[1])).catch(() => null);
}

/**
 * The admin dir of the worktree `tree` of `root`, checked: `tree/.git`
 * points at a folder directly in `root`'s `.git/worktrees/`, and that folder
 * points back at `tree/.git`.
 *
 * Called when main made the worktree, or found one a run made before it
 * kept the git dir; afterwards {@link checkPointer} compares with it.
 *
 * @throws {WorktreePointerError} On anything else.
 */
export async function worktreeGitDir(
  root: string,
  tree: string,
): Promise<string> {
  const realTree = await realpath(tree);
  const common = await realpath(
    resolve(
      root,
      (await gitText(root, ["rev-parse", "--git-common-dir"])).trim(),
    ),
  );
  const target = await pointerOf(realTree);
  const back = target
    ? await readFile(join(target, "gitdir"), "utf8")
        .then((text) => realpath(resolve(target, text.trim())))
        .catch(() => null)
    : null;
  if (
    !target ||
    dirname(target) !== join(common, "worktrees") ||
    back !== join(realTree, ".git")
  )
    throw new WorktreePointerError(
      "The worker's checkout no longer points at its own git data: its .git file was changed. Nothing in it is read or merged.",
    );
  return target;
}

/**
 * Throw unless `tree.path/.git` still points at `tree.gitDir`.
 *
 * @throws {WorktreePointerError}
 */
export async function checkPointer(tree: WorkerTree): Promise<void> {
  if ((await pointerOf(tree.path)) !== tree.gitDir)
    throw new WorktreePointerError(
      "The worker's checkout no longer points at its own git data: its .git file was changed. Nothing in it is read or merged.",
    );
}

/** `git` on a worker's worktree, with the git dir and work tree named. */
async function treeGit(
  tree: WorkerTree,
  args: string[],
  ok: number[] = [0],
): Promise<Run> {
  await checkPointer(tree);
  return git(
    tree.path,
    [`--git-dir=${tree.gitDir}`, `--work-tree=${tree.path}`, ...args],
    ok,
  );
}

async function treeText(tree: WorkerTree, args: string[]): Promise<string> {
  return (await treeGit(tree, args)).stdout.toString("utf8");
}

/** NUL-separated output, empty entries dropped. */
function zList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/**
 * The resolved top of the git checkout `folder` is, or an error naming why
 * orchestration cannot use it.
 */
export async function checkoutTop(folder: string): Promise<string> {
  let top: string;
  try {
    top = (await gitText(folder, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error("Orchestration needs the project to be a git checkout.");
  }
  const [realTop, realFolder] = await Promise.all([
    realpath(top),
    realpath(folder),
  ]);
  if (realTop !== realFolder)
    throw new Error(
      "Orchestration needs the project's folder to be the top of its git checkout.",
    );
  try {
    await gitText(folder, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error("Orchestration needs at least one commit in the checkout.");
  }
  return realTop;
}

/** What the user changed in `root` since HEAD, or added, and not ignored. */
async function uncommitted(root: string): Promise<string[]> {
  const [changed, added] = await Promise.all([
    gitText(root, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]),
    gitText(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  return [...new Set([...zList(changed), ...zList(added)])];
}

/** Copy one entry of the lead checkout into the worktree, or remove it. */
async function seedOne(root: string, tree: string, rel: string): Promise<void> {
  const from = join(root, rel);
  const to = join(tree, rel);
  const info = await lstat(from).catch(() => null);
  if (!info) {
    await rm(to, { force: true, recursive: false }).catch(() => {});
    return;
  }
  if (info.isDirectory()) return; // A nested repository: not ours to copy.
  await mkdir(dirname(to), { recursive: true });
  await rm(to, { force: true }).catch(() => {});
  if (info.isSymbolicLink()) {
    await symlink(await readlink(from), to);
    return;
  }
  if (!info.isFile()) return;
  await copyFile(from, to);
  await chmod(to, info.mode & 0o777);
}

export interface WorkerCheckout extends WorkerTree {
  /** The commit the worker started from. */
  baseline: string;
}

/**
 * Where a worker branch's baseline is kept (FE-90/D10):
 * `lanework/<run>/<task>` → `refs/lanework/baseline/<run>/<task>`. Outside
 * `refs/heads/`, so no branch list shows it.
 */
const baselineRef = (branch: string) =>
  `refs/lanework/baseline/${branch.replace(/^lanework\//, "")}`;

/** Where a worker's work is kept while it moves onto new files (D4). */
export const savedRef = (branch: string) =>
  `refs/lanework/saved/${branch.replace(/^lanework\//, "")}`;

/** The commit `rev` names in `root`, or null when it names none. */
async function commitOf(root: string, rev: string): Promise<string | null> {
  const run = await git(
    root,
    ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
    [1, 128],
  );
  return run.code === 0 ? run.stdout.toString("utf8").trim() : null;
}

/** Whether `ancestor` is `head` or one of its ancestors. */
async function isAncestor(
  root: string,
  ancestor: string,
  head: string,
): Promise<boolean> {
  const run = await git(
    root,
    ["merge-base", "--is-ancestor", ancestor, head],
    [1, 128],
  );
  return run.code === 0;
}

/**
 * The baseline of a worker branch that already exists (FE-90/D10): the one
 * the run kept, else the branch's ref, else its oldest baseline commit (a run
 * made before the ref was kept). Each must be on the branch's history; null
 * when none is.
 *
 * NOTE: Never the branch's tip: a worker that committed would have its own
 * commits taken for the lead's files, and they would never merge.
 */
async function knownBaseline(
  root: string,
  branch: string,
  known: string | null,
): Promise<string | null> {
  const head = `refs/heads/${branch}`;
  for (const rev of [known, baselineRef(branch)]) {
    if (!rev) continue;
    const commit = await commitOf(root, rev);
    if (commit && (await isAncestor(root, commit, head))) return commit;
  }
  const marked = zList(
    (
      await git(
        root,
        [
          "rev-list",
          "--first-parent",
          "-z",
          "--grep=^lanework: worker baseline$",
          head,
        ],
        [128],
      )
    ).stdout
      .toString("utf8")
      .replace(/\n/g, "\0"),
  );
  return marked.at(-1) ?? null;
}

/**
 * Make (or find again) the worktree `path` on `branch`, seeded with the lead
 * checkout's uncommitted files.
 *
 * Reusing an existing worktree, or a branch whose worktree is gone, keeps a
 * worker's work across an app restart: its baseline is found again
 * ({@link knownBaseline}), never taken from where the branch is now.
 *
 * @param known The baseline the run kept for it, when it has one.
 */
export async function createWorktree(
  root: string,
  path: string,
  branch: string,
  known: string | null = null,
): Promise<WorkerCheckout> {
  await gitText(root, ["check-ref-format", "--branch", branch]);
  if (await lstat(join(path, ".git")).catch(() => null)) {
    const real = await realpath(path);
    const tree = { path: real, gitDir: await worktreeGitDir(root, real) };
    const baseline =
      (await knownBaseline(root, branch, known)) ??
      (await treeText(tree, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    await gitText(root, ["update-ref", baselineRef(branch), baseline]);
    return { ...tree, baseline };
  }
  await mkdir(dirname(path), { recursive: true });
  const exists =
    (
      await git(
        root,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        [1],
      )
    ).code === 0;
  await gitText(
    root,
    exists
      ? ["worktree", "add", "--", path, branch]
      : ["worktree", "add", "-b", branch, "--", path, "HEAD"],
  );
  const real = await realpath(path);
  try {
    const tree = { path: real, gitDir: await worktreeGitDir(root, real) };
    const found = exists ? await knownBaseline(root, branch, known) : null;
    if (found) {
      await gitText(root, ["update-ref", baselineRef(branch), found]);
      return { ...tree, baseline: found };
    }
    if (!exists)
      for (const rel of await uncommitted(root)) await seedOne(root, real, rel);
    await treeText(tree, ["add", "-A"]);
    await treeText(tree, [
      ...COMMIT_FLAGS,
      "commit",
      "--no-verify",
      "--allow-empty",
      "-q",
      "-m",
      "lanework: worker baseline",
    ]);
    const baseline = (
      await treeText(tree, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    await gitText(root, ["update-ref", baselineRef(branch), baseline]);
    return { ...tree, baseline };
  } catch (error) {
    await removeWorktree(root, real, exists ? null : branch).catch(() => {});
    throw error;
  }
}

export interface MovedCheckout extends WorkerCheckout {
  /** Files whose lines both sides changed: they hold conflict markers. */
  conflicts: string[];
}

/**
 * Move a worker's work onto the lead checkout's files as they are now
 * (FE-90/D4): after its review conflicted, a retry starts from what it
 * conflicted with.
 *
 * The worker's state is committed and kept at {@link savedRef}; the worktree
 * and branch are made again at the same path (a CLI files its transcript
 * under the folder), and its changes since `baseline` are applied three ways.
 * A file both sides changed keeps conflict markers for the worker to resolve.
 * Nothing is staged: everything after the new baseline is the worker's.
 *
 * When the changes cannot be applied at all, the worktree is put back as it
 * was, on its saved state with its old baseline, and this throws.
 */
export async function moveWorktree(
  root: string,
  tree: WorkerTree,
  branch: string,
  baseline: string,
): Promise<MovedCheckout> {
  await treeText(tree, ["add", "-A"]);
  await treeText(tree, [
    ...COMMIT_FLAGS,
    "commit",
    "--no-verify",
    "--allow-empty",
    "-q",
    "-m",
    "lanework: worker state",
  ]);
  const saved = (
    await treeText(tree, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).trim();
  const keep = savedRef(branch);
  await gitText(root, ["update-ref", keep, saved]);
  const patch = (
    await git(root, [
      "diff",
      "--binary",
      "--full-index",
      "--no-renames",
      baseline,
      saved,
    ])
  ).stdout;
  await removeWorktree(root, tree.path, branch);
  const fresh = await createWorktree(root, tree.path, branch);
  const dir = await mkdtemp(join(tmpdir(), "lanework-move-"));
  try {
    const file = join(dir, "work.patch");
    await writeFile(file, patch, { mode: 0o600 });
    let conflicts: string[] = [];
    if (patch.length) {
      const run = await treeGit(
        fresh,
        ["apply", "--3way", "--whitespace=nowarn", file],
        [1],
      );
      conflicts = [
        ...new Set(
          zList(
            await treeText(fresh, [
              "diff",
              "--name-only",
              "-z",
              "--diff-filter=U",
            ]),
          ),
        ),
      ];
      if (run.code !== 0 && !conflicts.length)
        throw new Error("its changes do not apply to the current files");
      await treeText(fresh, ["reset", "-q"]);
    }
    await gitText(root, ["update-ref", "-d", keep]);
    return { ...fresh, conflicts };
  } catch (error) {
    // Put it back as it was: the saved state, on the old baseline.
    await removeWorktree(root, fresh.path, branch).catch(() => {});
    await gitText(root, [
      "worktree",
      "add",
      "-b",
      branch,
      "--",
      tree.path,
      saved,
    ]);
    await gitText(root, ["update-ref", baselineRef(branch), baseline]);
    await gitText(root, ["update-ref", "-d", keep]).catch(() => "");
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One file a worker changed since its baseline. */
export interface WorkerChange {
  /** A added, M modified, D deleted, T type changed. */
  status: string;
  path: string;
}

/**
 * Every file the worker changed since `baseline`, committed or not, tracked
 * or new, ignored files aside.
 */
export async function workerChanges(
  tree: WorkerTree,
  baseline: string,
): Promise<WorkerChange[]> {
  await treeText(tree, ["add", "-A"]);
  const out = await treeText(tree, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--no-renames",
    baseline,
  ]);
  const parts = zList(out);
  const changes: WorkerChange[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2)
    changes.push({
      status: (parts[at] as string).slice(0, 1),
      path: parts[at + 1] as string,
    });
  return changes;
}

/** A file's bytes at `baseline`, or null when it did not exist there. */
async function atBaseline(
  tree: WorkerTree,
  baseline: string,
  path: string,
): Promise<Buffer | null> {
  const run = await treeGit(
    tree,
    ["cat-file", "blob", `${baseline}:${path}`],
    [128],
  );
  return run.code === 0 ? run.stdout : null;
}

/** A regular file's bytes and mode, null when missing. */
async function readRegular(
  path: string,
): Promise<{ bytes: Buffer; mode: number } | null | "special"> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile()) return "special";
  return { bytes: await readFile(path), mode: info.mode & 0o777 };
}

const binary = (bytes: Buffer | null) =>
  bytes?.subarray(0, 8000).includes(0) === true;

/** A three-way text merge, or null on a conflict. */
async function mergeText(
  ours: Buffer,
  base: Buffer,
  theirs: Buffer,
): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "lanework-merge-"));
  try {
    const files = ["ours", "base", "theirs"].map((name) => join(dir, name));
    await Promise.all([
      writeFile(files[0] as string, ours, { mode: 0o600 }),
      writeFile(files[1] as string, base, { mode: 0o600 }),
      writeFile(files[2] as string, theirs, { mode: 0o600 }),
    ]);
    // Exit code: the number of conflicts (capped at 127).
    const run = await git(
      dir,
      ["merge-file", "-p", ...files],
      Array.from({ length: 127 }, (_, index) => index + 1),
    );
    return run.code === 0 ? run.stdout : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A regular file of the main checkout as the merge read it; null: absent. */
type Found = { bytes: Buffer; mode: number } | null;

/**
 * What review would do to one file of the main checkout. `ours` is what the
 * merge was worked out against: the file must still hold it when written.
 */
type Step =
  | { path: string; ours: Found; write: Buffer; mode: number }
  | { path: string; ours: Found; remove: true }
  | { path: string; keep: true };

export interface MergeResult {
  /** The files written or removed in the main checkout. */
  applied: string[];
  /** Why each file could not merge; nothing was written when any is here. */
  conflicts: { path: string; reason: string }[];
}

const same = (a: Buffer | null, b: Buffer | null) =>
  a === null ? b === null : b !== null && a.equals(b);

/** Whether `root`'s file system tells names apart by case alone (L2). */
async function foldsCase(root: string): Promise<boolean> {
  const [lower, upper] = await Promise.all([
    lstat(join(root, ".git")).catch(() => null),
    lstat(join(root, ".GIT")).catch(() => null),
  ]);
  return (
    !!lower && !!upper && lower.ino === upper.ino && lower.dev === upper.dev
  );
}

/** A file the merge changed in the main checkout, changed again. */
class MovedUnder extends Error {
  constructor(readonly path: string) {
    super("it changed in the checkout while merging");
  }
}

/** Write `bytes` to `target` through a temp file beside it. */
async function writeThrough(
  target: string,
  bytes: Buffer,
  mode: number,
  check?: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.lanework-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(temp, bytes, { mode });
    await chmod(temp, mode);
    await check?.();
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Merge the worker's `changes` into the main checkout, three ways per file.
 *
 * All or nothing: every file is worked out first, and the main checkout is
 * only written when none conflicts. Each file is compared again with what
 * the merge read right before it is replaced, so an edit (an autosave) made
 * meanwhile is never overwritten; that, or any failure while writing, puts
 * back every file already written (FE-90/D6).
 *
 * On a file system that ignores case, a worker's case-only rename is taken
 * as one: the old name is removed before the new one is written (D10).
 */
export async function mergeWorker(
  root: string,
  tree: WorkerTree,
  baseline: string,
  changes: readonly WorkerChange[],
): Promise<MergeResult> {
  const realRoot = await realpath(root);
  const folded = await foldsCase(realRoot);
  const removed = new Set(
    changes
      .filter((change) => change.status === "D")
      .map((change) => change.path),
  );
  const steps: Step[] = [];
  const conflicts: MergeResult["conflicts"] = [];
  for (const change of changes) {
    const { path } = change;
    const target = join(realRoot, path);
    // The target must be a plain path in the checkout: no link on the way.
    // Where case does not count, the name on disk may differ in case alone.
    const resolved = await resolvedPath(target).catch(() => null);
    const rel = resolved ? within(realRoot, resolved) : null;
    if (
      rel === null ||
      (rel !== path && (!folded || rel.toLowerCase() !== path.toLowerCase()))
    ) {
      conflicts.push({
        path,
        reason: "its path in the checkout goes through a symlink",
      });
      continue;
    }
    // The file on disk under another case is a different file in git: only
    // one the worker removes (a case-only rename) may give way to this one.
    const renamed = rel !== path && change.status !== "D";
    if (renamed && !removed.has(rel)) {
      conflicts.push({
        path,
        reason: `the checkout has ${rel}, which differs from it only by case`,
      });
      continue;
    }
    const [base, ours, theirs] = await Promise.all([
      atBaseline(tree, baseline, path),
      // Under another case on disk: no file has this name any more.
      rel !== path ? null : readRegular(target),
      // Gone in git; read under a name that ignores case, the file found
      // would be the one it was renamed to.
      change.status === "D" ? null : readRegular(join(tree.path, path)),
    ]);
    if (ours === "special" || theirs === "special") {
      conflicts.push({ path, reason: "it is a symlink or not a regular file" });
      continue;
    }
    const oursBytes = ours?.bytes ?? null;
    const theirsBytes = theirs?.bytes ?? null;
    if (same(oursBytes, theirsBytes)) {
      if (theirs && ours && theirs.mode !== ours.mode)
        steps.push({ path, ours, write: theirs.bytes, mode: theirs.mode });
      else steps.push({ path, keep: true });
      continue;
    }
    if (same(oursBytes, base)) {
      // The lead checkout did not touch it: the worker's version wins.
      steps.push(
        theirs
          ? { path, ours, write: theirs.bytes, mode: theirs.mode }
          : { path, ours, remove: true },
      );
      continue;
    }
    if (same(theirsBytes, base)) {
      steps.push({ path, keep: true });
      continue;
    }
    if (!oursBytes || !theirsBytes || !base) {
      conflicts.push({
        path,
        reason: "it was removed on one side and changed on the other",
      });
      continue;
    }
    if (binary(oursBytes) || binary(theirsBytes) || binary(base)) {
      conflicts.push({ path, reason: "both sides changed a binary file" });
      continue;
    }
    const merged = await mergeText(oursBytes, base, theirsBytes);
    if (!merged) {
      conflicts.push({ path, reason: "both sides changed the same lines" });
      continue;
    }
    steps.push({ path, ours, write: merged, mode: theirs?.mode ?? 0o644 });
  }
  if (conflicts.length) return { applied: [], conflicts };
  // Removals first: a case-only rename frees the name it is written under.
  const ordered = [
    ...steps.filter((step) => "remove" in step),
    ...steps.filter((step) => "write" in step),
  ];
  const applied: string[] = [];
  /** What each written file held before, to put back on a failure. */
  const undo: { target: string; before: Found }[] = [];
  let at = "";
  try {
    for (const step of ordered) {
      if ("keep" in step) continue;
      at = step.path;
      const target = join(realRoot, step.path);
      const expected = step.ours?.bytes ?? null;
      let before: Found = null;
      const unchanged = async () => {
        const now = await readRegular(target);
        if (now === "special" || !same(now?.bytes ?? null, expected))
          throw new MovedUnder(step.path);
        before = now;
      };
      if ("remove" in step) {
        await unchanged();
        await rm(target, { force: true });
      } else {
        await writeThrough(target, step.write, step.mode, unchanged);
      }
      undo.push({ target, before });
      applied.push(step.path);
    }
  } catch (error) {
    for (const entry of undo.reverse()) {
      const { target, before } = entry;
      await (before
        ? writeThrough(target, before.bytes, before.mode)
        : rm(target, { force: true })
      ).catch(() => {});
    }
    return {
      applied: [],
      conflicts: [
        {
          path: at,
          reason:
            error instanceof MovedUnder
              ? error.message
              : `writing it failed (${error instanceof Error ? error.message : String(error)}); every file was put back`,
        },
      ],
    };
  }
  return { applied, conflicts: [] };
}

/** Whether the worker changed anything since its baseline. */
export async function hasChanges(
  tree: WorkerTree,
  baseline: string,
): Promise<boolean> {
  return (await workerChanges(tree, baseline)).length > 0;
}

/**
 * Remove a worker's worktree, and its branch when `branch` is given.
 *
 * Never throws for a worktree or branch that is already gone.
 */
export async function removeWorktree(
  root: string,
  tree: string,
  branch: string | null,
): Promise<void> {
  await git(root, ["worktree", "remove", "--force", "--", tree], [128]).catch(
    () => null,
  );
  await rm(tree, { recursive: true, force: true }).catch(() => {});
  await git(root, ["worktree", "prune"]).catch(() => null);
  if (!branch) return;
  await git(root, ["branch", "-D", branch], [1]).catch(() => null);
  await git(root, ["update-ref", "-d", baselineRef(branch)], [1]).catch(
    () => null,
  );
}
