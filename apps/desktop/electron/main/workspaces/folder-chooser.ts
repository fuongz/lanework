import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import type { PickedFolder } from "../../../shared/workspaces";
import { folderExists } from "./local-folder";

/**
 * The two folder operations that need Electron.
 *
 * ⚠️ Separate from `local-folder.ts` on purpose: importing `electron` makes a
 * module unloadable outside an Electron process, and the reader is imported
 * directly by the test runner (a plain node process) so that what it counts can
 * be asserted against real files rather than through a launched app.
 */
/**
 * Ask the user for a folder.
 *
 * ⚠️ The chooser runs HERE, in main, and returns a path the renderer never
 * supplied. That is the only reason this app can read a folder at all: a
 * channel that accepted a path would let any code running in the window read
 * any file the user can.
 */
async function openChooser(title: string, many: boolean): Promise<string[]> {
  // ⚠️ A test seam, guarded the way `LANEWORK_TEST_USER_DATA` is: a native
  // chooser is the one control Playwright cannot drive, so without this the
  // whole create-with-folders flow could only ever be tested by writing the
  // link file behind the app's back — which tests nothing about the app.
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
  // Sheet-attached when there is a window to attach it to, which on macOS is
  // the difference between a modal the user can place and one that appears
  // detached from the app.
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
 * ⚠️ The whole point is that a path never travels renderer→main. A window is
 * given an id for a folder a HUMAN chose in this app, and `takeFolder` is the
 * only way back to the path — so the worst a compromised window can do with
 * this channel is re-link a folder its user already picked.
 *
 * ⚠️ Bounded and in-memory. It is a hand-off between two calls seconds apart,
 * not a record of anything: the links that outlive a run live in `store.ts`.
 */
const chosen = new Map<string, string>();
/** The id a path already has, so re-reading a link does not mint a new one. */
const ids = new Map<string, string>();
const MAX_PENDING = 200;

/**
 * Mint (or recall) the id for a path this app already knows.
 *
 * ⚠️ Used for folders that are ALREADY linked, so an editor can work on one
 * uniform list — the folders on the board and the ones just chosen — and hand
 * the whole list back as ids. The path still never travels renderer→main.
 */
export function registerFolder(path: string): PickedFolder {
  const existing = ids.get(path);
  if (existing) return { id: existing, path, name: basename(path) || path };
  const id = randomUUID();
  remember(id, path);
  return { id, path, name: basename(path) || path };
}

function remember(id: string, path: string): void {
  // Drop the oldest rather than growing without bound; an id nobody spent is
  // a dialog somebody closed.
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

/**
 * Ask for folders — several at once — and answer with ids the renderer may
 * hand back.
 */
export async function chooseFolders(title: string): Promise<PickedFolder[]> {
  const paths = await openChooser(title, true);
  return paths.map(registerFolder);
}

/**
 * The path an id was minted for, or null.
 *
 * ⚠️ NOT single-use. Creating a project can be refused — a taken key, a service
 * too old — and the dialog stays open with the folders still listed; spending
 * the ids on the first attempt would quietly drop every folder from the second.
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
