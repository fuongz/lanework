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
  REPO_LEAD_PREFIX,
  type TeamLead,
  type TeamLeadInput,
} from "../../../../shared/orchestration";
import { broadcast } from "../../ipc";
import { terminalFolder } from "../../projects";
import { testEnv } from "../../test-seams";
import { contextPickIn, createLeadStore, type LeadStore } from "./store";

export { isRepoOverlayInput } from "./store";

let instance: LeadStore | null = null;

/** Main's own listeners to a change of the leads, beside the pages. */
const changeListeners = new Set<(project: string | null) => void>();

/**
 * Hear every change of the leads in main, as the pages do: a session whose
 * conductor was deleted is the user's again, so its rail row changes too.
 *
 * @returns The unsubscribe.
 */
export function onTeamLeadsChanged(
  listener: (project: string | null) => void,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function store(): LeadStore {
  instance ??= createLeadStore({
    dir: join(app.getPath("userData"), "leads"),
    folderOf: terminalFolder,
    broadcast: (event) => {
      broadcast(leadsChannels.changed, event);
      for (const listener of changeListeners) {
        try {
          listener(event.project);
        } catch (error) {
          console.error("A leads listener failed", error);
        }
      }
    },
  });
  return instance;
}

/**
 * The lead a run in `project` starts under.
 *
 * @throws {Error} When no source holds `id`, or its repo file is broken.
 */
export function teamLeadOf(project: string, id: string): Promise<TeamLead> {
  return store().resolve(project, id);
}

/**
 * Whether conductor `id` is still one of `project`'s. A repo conductor whose
 * file does not parse counts as kept: it is broken, not gone.
 */
export async function isTeamLeadKept(
  project: string,
  id: string,
): Promise<boolean> {
  const { leads, errors } = await store().list(project);
  return (
    leads.some((lead) => lead.id === id) ||
    (id.startsWith(REPO_LEAD_PREFIX) && errors.length > 0)
  );
}

/**
 * Save a new conductor of `project`'s own, under an id no other one has
 * (BE-01: `lanework-control conductors.create`). The rail hears it through
 * the store's broadcast, as it does a save from the dialog.
 */
export function createConductor(
  project: string,
  input: Omit<TeamLeadInput, "id">,
): Promise<TeamLead> {
  return store().createPersonal(project, input);
}

/**
 * Ask for files and folders in `project`'s folder, as context files.
 *
 * NOTE: The chooser runs here and the paths it returns never came from the
 * page; what lies outside the project is counted and left out.
 */
async function pickContext(project: string): Promise<ContextPick> {
  const folder = await terminalFolder(project).catch(() => null);
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
  list: (project) => store().list(project),
  savePersonal: (project, lead) => store().savePersonal(project, lead),
  removePersonal: (project, id) => store().removePersonal(project, id),
  setDefault: (project, id) => store().setDefault(project, id),
  pickContext,
  inspectContext: (project, paths) => store().inspectContext(project, paths),
};

/**
 * Hand project `from`'s own conductors to project `to` (FE-142).
 *
 * @returns How many moved.
 */
export function moveConductors(from: string, to: string): Promise<number> {
  return store().moveProject(from, to);
}
