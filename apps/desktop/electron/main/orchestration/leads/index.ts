// Team leads in main (FE-88), wired to the app.
//
// `main/index.ts` registers `leadsMain` for the page; the run engine asks
// `teamLeadOf` for the lead a proposal names when the user approves it.
// Personal leads and the default live in `<userData>/leads/personal.json`,
// one set per project (FE-95). Context files (FE-96) are chosen here, with
// the native chooser opened on the project's folder.

import { join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import {
  type ContextPick,
  type LeadsMainHandlers,
  leadsChannels,
  type TeamLead,
} from "../../../../shared/orchestration";
import { broadcast } from "../../ipc";
import { testEnv } from "../../test-seams";
import { terminalFolder } from "../../workspaces";
import { contextPickIn, createLeadStore, type LeadStore } from "./store";

let instance: LeadStore | null = null;

function store(): LeadStore {
  instance ??= createLeadStore({
    dir: join(app.getPath("userData"), "leads"),
    folderOf: terminalFolder,
    broadcast: (event) => broadcast(leadsChannels.changed, event),
  });
  return instance;
}

/**
 * The lead a run in `workspace` starts under.
 *
 * @throws {Error} When no source holds `id`, or its repo file is broken.
 */
export function teamLeadOf(workspace: string, id: string): Promise<TeamLead> {
  return store().resolve(workspace, id);
}

/**
 * Ask for files and folders in `workspace`'s folder, as context files.
 *
 * NOTE: The chooser runs here and the paths it returns never came from the
 * page; what lies outside the project is counted and left out.
 */
async function pickContext(workspace: string): Promise<ContextPick> {
  const folder = await terminalFolder(workspace).catch(() => null);
  if (!folder)
    throw new Error("This project has no folder on this machine to pick from.");
  // NOTE: A test seam: Playwright cannot drive a native chooser.
  const seam = testEnv("LANEWORK_TEST_CONTEXT_FILES");
  if (seam) return contextPickIn(folder, seam.split(":").filter(Boolean));
  const options = {
    title: "Add context files",
    message: "Files and folders the conductor reads before it answers.",
    buttonLabel: "Add",
    defaultPath: folder,
    // Files and folders in one sheet: macOS offers both; elsewhere the
    // chooser shows files.
    properties: ["openFile", "openDirectory", "multiSelections"] as (
      | "openFile"
      | "openDirectory"
      | "multiSelections"
    )[],
  };
  const parent = BrowserWindow.getFocusedWindow();
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return { paths: [], outside: 0 };
  return contextPickIn(folder, result.filePaths);
}

export const leadsMain: LeadsMainHandlers = {
  list: (workspace) => store().list(workspace),
  savePersonal: (workspace, lead) => store().savePersonal(workspace, lead),
  removePersonal: (workspace, id) => store().removePersonal(workspace, id),
  setDefault: (workspace, id) => store().setDefault(workspace, id),
  pickContext,
  inspectContext: (workspace, paths) =>
    store().inspectContext(workspace, paths),
};
