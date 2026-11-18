// Structural search in a project's linked folder (FE-151): the renderer's
// `fsSearch:structural` handler. The page names a project and a folder
// index; main resolves the path, as `repo-search.ts` does, so a search never
// reaches a folder the project does not link.
//
// NOTE: The search itself is the kit's (`../kit/structural.ts`, FE-152), so
// the app, `lwk` and the lanework-kit MCP run one implementation.
import { ipcMain, type WebContents } from "electron";
import {
  type FileMatch,
  fsSearchChannels,
  type SearchStructuralOptions,
} from "../../shared/fs-search";
import { STRUCTURAL_LANGS, searchStructuralIn } from "../kit/structural";
import { FsSearchTimeoutError } from "./fs-kit";
import { assertTrustedSender } from "./ipc";
import { arity, int, oneOf, slug } from "./ipc-args";
import { folderAt } from "./repo-search";

/** The longest pattern taken, in characters. */
const PATTERN_MAX = 1_000;

/** Each window's search in flight, by its web contents' id. */
const running = new Map<number, AbortController>();
/** The windows whose teardown already aborts their search. */
const watched = new WeakSet<WebContents>();

/**
 * The options from the renderer, checked.
 *
 * @throws When they are not an object with at most a known `lang`.
 */
function optionsOf(value: unknown): SearchStructuralOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Those are not search options.");
  const { lang } = value as Record<string, unknown>;
  if (lang === undefined || lang === null) return {};
  return {
    lang: oneOf(lang, STRUCTURAL_LANGS, "That is not a pattern language."),
  };
}

/**
 * The pattern from the renderer, checked.
 *
 * @throws When it is not a string of at most {@link PATTERN_MAX} characters.
 */
function patternOf(value: unknown): string {
  if (typeof value !== "string" || value.length > PATTERN_MAX)
    throw new Error("That pattern is too long.");
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
 * Register `fsSearch:structural`: `(slug, folder, pattern, opts)`, where
 * `folder` is the index of the project's linked folder (null for the
 * primary one), answered with `FileMatch[]`.
 *
 * One search per window, as `fsSearch:text` does: a new pattern aborts the
 * one before it, which resolves as an empty list.
 *
 * NOTE: `ipcMain.handle` with {@link assertTrustedSender}, not `handle()`:
 * the per-window abort needs the event's sender.
 */
export function registerStructuralSearch(devUrl: string | undefined): void {
  ipcMain.handle(
    fsSearchChannels.structural,
    async (event, ...args: unknown[]): Promise<FileMatch[] | undefined> => {
      if (!assertTrustedSender(event, devUrl)) return undefined;
      const [rawSlug, rawFolder, rawPattern, rawOpts] = arity(args, 4);
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
      const pattern = patternOf(rawPattern);
      const opts = optionsOf(rawOpts);
      const controller = begin(event.sender);
      try {
        if (!pattern.trim()) return [];
        const root = await folderAt(key, index);
        if (controller.signal.aborted) return [];
        return await searchStructuralIn(root, pattern, {
          ...opts,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return [];
        if (error instanceof FsSearchTimeoutError)
          throw new Error(
            "The search took too long. Try a pattern with a name in it.",
          );
        throw error;
      } finally {
        if (running.get(event.sender.id) === controller)
          running.delete(event.sender.id);
      }
    },
  );
}
