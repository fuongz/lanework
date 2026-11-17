// A folder's file list (FE-149): `rg --files` with the bundled ripgrep, or
// an fdir walk when rg cannot run.
import { RipgrepMissingError, runRg } from "./rg";

// NOTE: `require`, not `import`. esbuild resolves an `import` through fdir's
// "import" condition, its ESM build, whose `createRequire(import.meta.url)`
// throws once bundled into main's CJS (`import.meta` is empty there). A
// `require` takes the "require" condition, the CJS build.
const { fdir } = require("fdir") as typeof import("fdir");

export interface ListFilesOptions {
  /** Include dotfiles (`.github/…`); `.git/` itself never. False when unset. */
  hidden?: boolean;
  /** The most paths returned; 50 000 when unset. */
  maxFiles?: number;
  /** Milliseconds; 10 s when unset. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FileList {
  /** Relative to the root, `/`-separated, in no particular order. */
  files: string[];
  /** Cut at `maxFiles` or by the timeout. */
  truncated: boolean;
  /** `rg` honoured `.gitignore`; `walk` is fdir with {@link WALK_SKIP} only. */
  source: "rg" | "walk";
}

/** The folders a walk never enters: no `.gitignore` is read there. */
export const WALK_SKIP: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
]);

/**
 * Every file under `root` that `rg` would search: `.gitignore` respected,
 * hidden files skipped unless `hidden`.
 *
 * When `rg` is missing or fails, fdir walks the folder instead, skipping
 * {@link WALK_SKIP}, which is the most a walk can do without reading ignore
 * files.
 *
 * @throws The signal's reason when aborted; the child is killed first.
 */
export async function listFiles(
  root: string,
  options: ListFilesOptions = {},
): Promise<FileList> {
  const maxFiles = options.maxFiles ?? 50_000;
  try {
    return await listWithRg(root, maxFiles, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (!(error instanceof RipgrepMissingError))
      console.warn("rg --files failed; walking the folder instead", error);
    return listWithWalk(root, maxFiles, options);
  }
}

async function listWithRg(
  root: string,
  maxFiles: number,
  options: ListFilesOptions,
): Promise<FileList> {
  const files: string[] = [];
  const args = ["--files"];
  if (options.hidden) args.push("--hidden", "--glob", "!.git");
  args.push("--", ".");
  const result = await runRg(args, {
    cwd: root,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
    onLine: (line) => {
      if (files.length >= maxFiles) return false;
      const slashed = line.replaceAll("\\", "/");
      files.push(slashed.startsWith("./") ? slashed.slice(2) : slashed);
      return undefined;
    },
  });
  return {
    files,
    truncated: result.stopped || result.timedOut,
    source: "rg",
  };
}

async function listWithWalk(
  root: string,
  maxFiles: number,
  options: ListFilesOptions,
): Promise<FileList> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const hidden = options.hidden === true;
  const found = await new fdir()
    .withRelativePaths()
    .withPathSeparator("/")
    .withMaxFiles(maxFiles + 1)
    .withAbortSignal(signal)
    .exclude((name) => WALK_SKIP.has(name) || (!hidden && name.startsWith(".")))
    .filter((path) => hidden || !path.split("/").at(-1)?.startsWith("."))
    .crawl(root)
    .withPromise();
  if (options.signal?.aborted) throw options.signal.reason;
  return {
    files: found.slice(0, maxFiles),
    truncated: found.length > maxFiles || timeout.aborted,
    source: "walk",
  };
}
