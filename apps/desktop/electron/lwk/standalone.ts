// The kit run by `lwk` when the app is not up (FE-152), on the app's own
// Node (`cli.ts`).
//
// - Scope: the working folder only. A FOLDER outside it is refused, as the
//   kit refuses one outside its roots (`../kit/scope.ts`).
// - ripgrep: the app's bundled `rg-<arch>`. This bundle is
//   `dist/electron/lwk/standalone.cjs`, a sibling of `dist/electron/bin`, so
//   fs-kit's own lookup (`../main/fs-kit/rg.ts`, relative to the running
//   file) finds it. Never an `rg` on PATH.
// - Without ripgrep: `find` and `ls` walk the folder with fdir (fs-kit's own
//   fallback), and `grep` reads the files here ({@link searchWithoutRg}).
//   `sessions` needs ripgrep.
// - Natives: ast-grep from `dist/electron/node_modules`, as the lanework-kit
//   MCP server loads it, so `sg` works without the app. fff is on too: its
//   cold index (~0.3 s on a 30k-file repo) is worth it, since the fallback
//   ranking finds `conversation-view.tsx` for `convview` and fff does. The
//   warm index is still the app's, through its socket.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileMatch, MatchLine } from "@lanework/protocol";
import {
  appNatives,
  KIT_METHODS,
  KitError,
  type KitMethod,
  type KitNatives,
  resolveFolder,
} from "../kit";
import { listFiles } from "../main/fs-kit";

/** The app's natives (fff and ast-grep), as the MCP server runs them alone. */
const NATIVES: KitNatives = appNatives;

/** Files bigger than this are skipped by {@link searchWithoutRg}. */
const FILE_MAX = 2 * 1024 * 1024;
/** Matching lines kept per file, as fs-kit keeps them. */
const LINES_PER_FILE = 20;
/** A line longer than this is cut to a window around its first match. */
const LINE_MAX = 500;

/**
 * Run `method` here, scoped to `cwd`.
 *
 * @throws {KitError} As the tool does.
 */
export async function runHere(
  method: KitMethod,
  params: Record<string, unknown>,
  cwd: string,
): Promise<unknown> {
  const ctx = { cwd, roots: [cwd], natives: NATIVES };
  try {
    return await KIT_METHODS[method](params, ctx);
  } catch (error) {
    if (
      error instanceof KitError &&
      error.code === "unavailable" &&
      method === "search_text"
    )
      return searchWithoutRg(params, cwd);
    if (
      error instanceof KitError &&
      error.code === "unavailable" &&
      method === "search_structural"
    )
      throw new KitError(
        "unavailable",
        "Structural search needs ast-grep, which this build does not have. Open the Lanework app and try again.",
      );
    throw error;
  }
}

/** `glob` as a RegExp over a `/`-separated path, the way rg reads one. */
function globRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A glob without a slash matches the file's name anywhere.
  return new RegExp(glob.includes("/") ? `^${source}$` : `(^|/)${source}$`);
}

/** Whether `path` passes `globs`: any include matches, no exclude does. */
function passes(path: string, globs: string[]): boolean {
  const includes = globs.filter((glob) => !glob.startsWith("!"));
  const excludes = globs.filter((glob) => glob.startsWith("!"));
  if (excludes.some((glob) => globRegExp(glob.slice(1)).test(path)))
    return false;
  return (
    includes.length === 0 ||
    includes.some((glob) => globRegExp(glob).test(path))
  );
}

/** `line`'s matches of `pattern` as `[start, end)` ranges. */
function rangesOf(line: string, pattern: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    if (match[0].length === 0) break;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * search_text without ripgrep: the folder's file list (fdir's walk, with
 * the `.gitignore` files), each file read and matched here.
 *
 * NOTE: A regex is JavaScript's, not ripgrep's: the common subset agrees.
 *
 * @throws {KitError} For a bad query, regex or folder.
 */
async function searchWithoutRg(
  raw: Record<string, unknown>,
  cwd: string,
): Promise<FileMatch[]> {
  const query = raw.query;
  if (typeof query !== "string" || !query)
    throw new KitError("invalid", "query must be a non-empty string.");
  const root = await resolveFolder(
    typeof raw.folder === "string" ? raw.folder : undefined,
    cwd,
    [cwd],
  );
  const flags = raw.case_sensitive === true ? "g" : "gi";
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      raw.regex === true ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      flags,
    );
  } catch (error) {
    throw new KitError(
      "invalid",
      `Not a valid regular expression: ${(error as Error).message}.`,
    );
  }
  const globs = Array.isArray(raw.globs) ? (raw.globs as string[]) : [];
  const limit = typeof raw.limit === "number" ? raw.limit : 50;
  const { files } = await listFiles(root);
  const out: FileMatch[] = [];
  for (const path of files.sort()) {
    if (!passes(path, globs)) continue;
    let text: string;
    try {
      const bytes = await readFile(join(root, path));
      if (bytes.length > FILE_MAX || bytes.includes(0)) continue;
      text = bytes.toString("utf8");
    } catch {
      continue;
    }
    const lines: MatchLine[] = [];
    let truncated = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const ranges = rangesOf(line, pattern);
      if (ranges.length === 0) continue;
      if (lines.length === LINES_PER_FILE) {
        truncated = true;
        break;
      }
      const start = Math.max(0, (ranges[0]?.[0] ?? 0) - LINE_MAX / 2);
      const cut = line.length > LINE_MAX;
      const shown = cut ? line.slice(start, start + LINE_MAX) : line;
      lines.push({
        line: index + 1,
        text: shown,
        ranges: cut ? rangesOf(shown, pattern) : ranges,
      });
    }
    if (lines.length === 0) continue;
    out.push({ path, lines, truncated });
    if (out.length >= limit) {
      if (out.at(-1)) (out.at(-1) as FileMatch).truncated = true;
      break;
    }
  }
  return out;
}
