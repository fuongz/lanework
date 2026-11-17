import { app } from "electron";
import { type FileHit, fsSearchChannels } from "../../../shared/fs-search";
import { projectFiles, rankFiles } from "../conversation/suggest";
import { handle } from "../ipc";
import { arity, int, slug } from "../ipc-args";
import { folderAt } from "../repo-search";
import { closeFinders, findFiles } from "./finder";

/** The longest query taken, in characters. */
const QUERY_MAX = 1_000;
/** The answers one query returns when the page names no limit. */
const LIMIT_DEFAULT = 50;
/** The most answers one query returns. */
const LIMIT_MAX = 500;

/**
 * Register `fsSearch:files`: `(slug, folder, query, limit)`, answered with
 * `FileHit[]`, best first. `folder` is the index of the project's linked
 * folder (null for the primary one) and `limit` null for
 * {@link LIMIT_DEFAULT}.
 *
 * Every finder is destroyed at quit.
 */
export function registerFileFinder(devUrl: string | undefined): void {
  handle(fsSearchChannels.files, devUrl, async (args): Promise<FileHit[]> => {
    const [rawSlug, rawFolder, rawQuery, rawLimit] = arity(args, 4);
    const key = slug(rawSlug, "A project is required.");
    const index =
      rawFolder === null
        ? 0
        : int(rawFolder, 0, 255, "That is not one of this project's folders.");
    if (typeof rawQuery !== "string" || rawQuery.length > QUERY_MAX)
      throw new Error("That search is too long.");
    const limit =
      rawLimit === null
        ? LIMIT_DEFAULT
        : int(rawLimit, 1, LIMIT_MAX, "That is not a number of files.");
    const root = await folderAt(key, index);
    const found = await findFiles(root, rawQuery, limit);
    return found ?? rankFiles(await projectFiles(root), rawQuery, limit);
  });
  app.on("will-quit", () => closeFinders());
}
