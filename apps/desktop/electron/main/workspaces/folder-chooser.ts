import { BrowserWindow, dialog, shell } from "electron";
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
export async function pickFolder(title: string): Promise<string | null> {
  const options = {
    title,
    message: title,
    properties: ["openDirectory" as const],
    buttonLabel: "Use this folder",
  };
  const parent = BrowserWindow.getFocusedWindow();
  // Sheet-attached when there is a window to attach it to, which on macOS is
  // the difference between a modal the user can place and one that appears
  // detached from the app.
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

/** Show a folder in the OS file manager. Never opens a file. */
export async function revealFolder(path: string): Promise<void> {
  if (!(await folderExists(path)))
    throw new Error("That folder is no longer on this machine.");
  const error = await shell.openPath(path);
  if (error) throw new Error("Could not open that folder on this machine.");
}
