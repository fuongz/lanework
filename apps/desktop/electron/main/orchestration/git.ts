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
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

export interface WorkerCheckout {
  /** The worktree's folder, resolved. */
  path: string;
  /** The commit the worker started from. */
  baseline: string;
}

/**
 * Make (or find again) the worktree `path` on `branch`, seeded with the lead
 * checkout's uncommitted files.
 *
 * Reusing an existing worktree keeps a worker's work across an app restart.
 */
export async function createWorktree(
  root: string,
  path: string,
  branch: string,
): Promise<WorkerCheckout> {
  if (await stat(join(path, ".git")).catch(() => null)) {
    const real = await realpath(path);
    const baseline = (
      await gitText(real, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    return { path: real, baseline };
  }
  await gitText(root, ["check-ref-format", "--branch", branch]);
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
    if (!exists)
      for (const rel of await uncommitted(root)) await seedOne(root, real, rel);
    await gitText(real, ["add", "-A"]);
    await gitText(real, [
      ...COMMIT_FLAGS,
      "commit",
      "--no-verify",
      "--allow-empty",
      "-q",
      "-m",
      "lanework: worker baseline",
    ]);
    const baseline = (
      await gitText(real, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    return { path: real, baseline };
  } catch (error) {
    await removeWorktree(root, real, exists ? null : branch).catch(() => {});
    throw error;
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
  tree: string,
  baseline: string,
): Promise<WorkerChange[]> {
  await gitText(tree, ["add", "-A"]);
  const out = await gitText(tree, [
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
  tree: string,
  baseline: string,
  path: string,
): Promise<Buffer | null> {
  const run = await git(
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

/** What review would do to one file of the main checkout. */
type Step =
  | { path: string; write: Buffer; mode: number }
  | { path: string; remove: true }
  | { path: string; keep: true };

export interface MergeResult {
  /** The files written or removed in the main checkout. */
  applied: string[];
  /** Why each file could not merge; nothing was written when any is here. */
  conflicts: { path: string; reason: string }[];
}

/**
 * Merge the worker's `changes` into the main checkout, three ways per file.
 *
 * All or nothing: every file is worked out first, and the main checkout is
 * only written when none conflicts.
 */
export async function mergeWorker(
  root: string,
  tree: string,
  baseline: string,
  changes: readonly WorkerChange[],
): Promise<MergeResult> {
  const realRoot = await realpath(root);
  const steps: Step[] = [];
  const conflicts: MergeResult["conflicts"] = [];
  for (const change of changes) {
    const { path } = change;
    const target = join(realRoot, path);
    // The target must be a plain path in the checkout: no link on the way.
    const resolved = await resolvedPath(target).catch(() => null);
    if (!resolved || within(realRoot, resolved) !== path) {
      conflicts.push({
        path,
        reason: "its path in the checkout goes through a symlink",
      });
      continue;
    }
    const [base, ours, theirs] = await Promise.all([
      atBaseline(tree, baseline, path),
      readRegular(target),
      readRegular(join(tree, path)),
    ]);
    if (ours === "special" || theirs === "special") {
      conflicts.push({ path, reason: "it is a symlink or not a regular file" });
      continue;
    }
    const oursBytes = ours?.bytes ?? null;
    const theirsBytes = theirs?.bytes ?? null;
    const same = (a: Buffer | null, b: Buffer | null) =>
      a === null ? b === null : b !== null && a.equals(b);
    if (same(oursBytes, theirsBytes)) {
      if (theirs && ours && theirs.mode !== ours.mode)
        steps.push({ path, write: theirs.bytes, mode: theirs.mode });
      else steps.push({ path, keep: true });
      continue;
    }
    if (same(oursBytes, base)) {
      // The lead checkout did not touch it: the worker's version wins.
      steps.push(
        theirs
          ? { path, write: theirs.bytes, mode: theirs.mode }
          : { path, remove: true },
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
    steps.push({ path, write: merged, mode: theirs?.mode ?? 0o644 });
  }
  if (conflicts.length) return { applied: [], conflicts };
  const applied: string[] = [];
  for (const step of steps) {
    if ("keep" in step) continue;
    const target = join(realRoot, step.path);
    if ("remove" in step) {
      await rm(target, { force: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.lanework-${randomUUID().slice(0, 8)}`;
      await writeFile(temp, step.write, { mode: step.mode });
      await chmod(temp, step.mode);
      await rename(temp, target);
    }
    applied.push(step.path);
  }
  return { applied, conflicts: [] };
}

/** Whether the worker changed anything since its baseline. */
export async function hasChanges(
  tree: string,
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
  if (branch) await git(root, ["branch", "-D", branch], [1]).catch(() => null);
}
