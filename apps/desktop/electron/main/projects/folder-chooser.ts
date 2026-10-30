// The folder operations that need Electron.
//
// Kept apart from `local-folder.ts`: importing `electron` makes a module
// unloadable outside an Electron process, and the test runner (plain Node)
// imports the folder reader directly to check it against real files.
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import type { PickedFolder } from "../../../shared/projects";
import { folderExists } from "./local-folder";

/**
 * Ask the user for one folder, or several.
 *
 * NOTE: The chooser runs here, in main, and returns a path the renderer never
 * supplied. That is the only reason this app may read a folder at all: a
 * channel that accepted a path would let any code in the window read any file
 * the user can.
 */
async function openChooser(title: string, many: boolean): Promise<string[]> {
  // NOTE: A test seam, guarded like `LANEWORK_TEST_USER_DATA`. A native
  // chooser is the one control Playwright cannot drive; without this the
  // create-with-folders flow could only be tested by writing the link file
  // behind the app's back, which tests nothing about the app.
  if (!app.isPackaged && process.env.LANEWORK_TEST_FOLDERS) {
    const paths = process.env.LANEWORK_TEST_FOLDERS.split(":").filter(Boolean);
    return many ? paths : paths.slice(0, 1);
  }
  const properties: ("openDirectory" | "multiSelections")[] = many
    ? ["openDirectory", "multiSelections"]
    : ["openDirectory"];
  const options = {
    title,
    message: title,
    properties,
    buttonLabel: many ? "Add folders" : "Use this folder",
  };
  const parent = BrowserWindow.getFocusedWindow();
  // Attached as a sheet when there is a window: on macOS that keeps the modal
  // with the app instead of floating detached from it.
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  return result.filePaths;
}

export async function pickFolder(title: string): Promise<string | null> {
  return (await openChooser(title, false))[0] ?? null;
}

/**
 * Every folder this app has handed a window an id for, this run.
 *
 * NOTE: A path never travels renderer→main. A window gets an id for a folder
 * a human chose in this app, and {@link folderFor} is the only way back to
 * the path, so the worst a compromised window can do is re-link a folder its
 * user already picked.
 *
 * Bounded and in memory: a hand-off between two calls seconds apart. The
 * links that outlive a run live in `store.ts`.
 */
const chosen = new Map<string, string>();
/** The id a path already has, so re-reading a link does not mint a new one. */
const ids = new Map<string, string>();
const MAX_PENDING = 200;

/**
 * Mint, or recall, the id for a path this app already knows.
 *
 * Used for folders already linked, so an editor works on one list (the
 * folders on the board and the ones just chosen) and hands it all back as
 * ids. The path still never travels renderer→main.
 */
export function registerFolder(path: string): PickedFolder {
  const existing = ids.get(path);
  if (existing) return { id: existing, path, name: basename(path) || path };
  const id = randomUUID();
  remember(id, path);
  return { id, path, name: basename(path) || path };
}

function remember(id: string, path: string): void {
  // Drop the oldest rather than grow without bound: an id nobody spent is a
  // dialog somebody closed.
  if (chosen.size >= MAX_PENDING) {
    const oldest = chosen.keys().next();
    if (!oldest.done) {
      ids.delete(chosen.get(oldest.value) ?? "");
      chosen.delete(oldest.value);
    }
  }
  chosen.set(id, path);
  ids.set(path, id);
}

/** Ask for several folders, and answer with ids the renderer may hand back. */
export async function chooseFolders(title: string): Promise<PickedFolder[]> {
  const paths = await openChooser(title, true);
  return paths.map(registerFolder);
}

/**
 * Ids for the folders among paths dragged in from the file manager (FE-106).
 *
 * The preload read them from dropped files (see `DesktopFolderApi.drop`).
 * Only existing directories get an id: a dropped file, or a path that is
 * gone by now, is left out rather than refused, so one stray file does not
 * cost the folders dropped with it.
 */
export async function registerDropped(
  paths: readonly string[],
): Promise<PickedFolder[]> {
  const picked: PickedFolder[] = [];
  for (const path of new Set(paths)) {
    if (isAbsolute(path) && (await folderExists(path)))
      picked.push(registerFolder(path));
  }
  return picked;
}

/**
 * The path an id was minted for, or null.
 *
 * NOTE: Not single-use. Creating a project can be refused (a taken key, a
 * service too old) and the dialog stays open with the folders still listed.
 * Spending the ids on the first attempt would drop every folder from the
 * second.
 */
export function folderFor(id: string): string | null {
  return chosen.get(id) ?? null;
}

/** Show a folder in the OS file manager. Never opens a file. */
export async function revealFolder(path: string): Promise<void> {
  if (!(await folderExists(path)))
    throw new Error("That folder is no longer on this machine.");
  const error = await shell.openPath(path);
  if (error) throw new Error("Could not open that folder on this machine.");
}
