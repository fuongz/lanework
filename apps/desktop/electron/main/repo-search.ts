// ⌘⇧F: content search in one of a project's linked folders (FE-149), with
// the bundled ripgrep through fs-kit. The page names a project and a folder
// index; main resolves the path, so a search never reaches a folder the
// project does not link.
import { stat } from "node:fs/promises";
import { ipcMain, type WebContents } from "electron";
import {
  type FileMatch,
  fsSearchChannels,
  type SearchTextOptions,
} from "../../shared/fs-search";
import { FsSearchTimeoutError, searchText } from "./fs-kit";
import { assertTrustedSender } from "./ipc";
import { arity, int, slug } from "./ipc-args";
import { knownProject } from "./projects/session";
import { readFolders } from "./projects/store";

/** The longest query taken, in characters. */
const QUERY_MAX = 1_000;
/** The most globs one search takes. */
const GLOBS_MAX = 50;
/** The longest glob taken, in characters. */
const GLOB_MAX = 500;

/** Each window's search in flight, by its web contents' id. */
const running = new Map<number, AbortController>();
/** The windows whose teardown already aborts their search. */
const watched = new WeakSet<WebContents>();

/**
 * Folder `index` of the project `key`, as this machine linked it.
 *
 * NOTE: Resolved as `worktree-ipc.ts` resolves its folders, through
 * {@link knownProject}, which knows local boards too.
 *
 * @throws When the project is unknown, links no such folder, or the folder
 *   is gone.
 */
async function folderAt(key: string, index: number): Promise<string> {
  const { record, project } = await knownProject(key);
  const path = (await readFolders(record))[project.slug]?.[index];
  if (!path) throw new Error("That is not one of this project's folders.");
  const found = await stat(path).catch(() => null);
  if (!found?.isDirectory())
    throw new Error("That folder is not on this machine.");
  return path;
}

/**
 * The search options from the renderer, checked.
 *
 * @throws When they are not an object of the expected fields.
 */
function optionsOf(value: unknown): SearchTextOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Those are not search options.");
  const { regex, caseSensitive, globs } = value as Record<string, unknown>;
  const flag = (field: unknown) => {
    if (field !== undefined && typeof field !== "boolean")
      throw new Error("Those are not search options.");
    return field === true;
  };
  if (globs !== undefined) {
    if (!Array.isArray(globs) || globs.length > GLOBS_MAX)
      throw new Error("Too many file filters.");
    for (const glob of globs)
      if (typeof glob !== "string" || !glob || glob.length > GLOB_MAX)
        throw new Error("That is not a file filter.");
  }
  return {
    regex: flag(regex),
    caseSensitive: flag(caseSensitive),
    globs: globs as string[] | undefined,
  };
}

/**
 * The query from the renderer, checked.
 *
 * @throws When it is not a string of at most {@link QUERY_MAX} characters.
 */
function queryOf(value: unknown): string {
  if (typeof value !== "string" || value.length > QUERY_MAX)
    throw new Error("That search is too long.");
  return value;
}

/**
 * Start `sender`'s search, aborting the one it started before.
 *
 * A window's search also aborts when the window goes away.
 */
function begin(sender: WebContents): AbortController {
  const id = sender.id;
  running.get(id)?.abort();
  if (!watched.has(sender)) {
    watched.add(sender);
    sender.once("destroyed", () => {
      running.get(id)?.abort();
      running.delete(id);
    });
  }
  const controller = new AbortController();
  running.set(id, controller);
  return controller;
}

/**
 * Register `fsSearch:text`: `(slug, folder, query, opts)`, where `folder`
 * is the index of the project's linked folder (null for the primary one),
 * as `worktree.files` takes it.
 *
 * One search per window: a new query aborts the one before it, which
 * resolves as an empty list. The page only shows the latest query's answer,
 * so the superseded one's is never read; resolving rather than throwing
 * keeps Electron from logging every keystroke's cancel as a handler error.
 *
 * NOTE: `ipcMain.handle` with {@link assertTrustedSender}, not `handle()`:
 * the per-window abort needs the event's sender.
 */
export function registerRepoSearch(devUrl: string | undefined): void {
  ipcMain.handle(
    fsSearchChannels.text,
    async (event, ...args: unknown[]): Promise<FileMatch[] | undefined> => {
      if (!assertTrustedSender(event, devUrl)) return undefined;
      const [rawSlug, rawFolder, rawQuery, rawOpts] = arity(args, 4);
      const key = slug(rawSlug, "A project is required.");
      const index =
        rawFolder === null
          ? 0
          : int(
              rawFolder,
              0,
              255,
              "That is not one of this project's folders.",
            );
      const query = queryOf(rawQuery);
      const opts = optionsOf(rawOpts);
      const controller = begin(event.sender);
      try {
        if (!query) return [];
        const root = await folderAt(key, index);
        if (controller.signal.aborted) return [];
        return await searchText(root, query, {
          ...opts,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return [];
        if (error instanceof FsSearchTimeoutError)
          throw new Error(
            "The search took too long. Try a longer query or a file filter.",
          );
        throw error;
      } finally {
        if (running.get(event.sender.id) === controller)
          running.delete(event.sender.id);
      }
    },
  );
}
