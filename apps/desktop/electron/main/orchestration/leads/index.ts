// Team leads in main (FE-88), wired to the app.
//
// `main/index.ts` registers `leadsMain` for the page; the run engine asks
// `teamLeadOf` for the lead a proposal names when the user approves it.
// Personal leads and the default live in `<userData>/leads/personal.json`,
// one set per project (FE-95).

import { join } from "node:path";
import { app } from "electron";
import {
  type LeadsMainHandlers,
  leadsChannels,
  type TeamLead,
} from "../../../../shared/orchestration";
import { broadcast } from "../../ipc";
import { terminalFolder } from "../../workspaces";
import { createLeadStore, type LeadStore } from "./store";

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

export const leadsMain: LeadsMainHandlers = {
  list: (workspace) => store().list(workspace),
  savePersonal: (workspace, lead) => store().savePersonal(workspace, lead),
  removePersonal: (workspace, id) => store().removePersonal(workspace, id),
  setDefault: (workspace, id) => store().setDefault(workspace, id),
};
