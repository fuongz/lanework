// The autonomy dial (PD-08): the settings page's and the board's calls.
//
// Registering does no work: a project's file is read on its first get.

import { join } from "node:path";
import {
  type AutonomyEvent,
  type AutonomySettings,
  autonomyChannels,
} from "../../../shared/autonomy";
import { broadcast, handle } from "../ipc";
import { arity, slug } from "../ipc-args";
import { knownProject } from "../projects/session";
import { accountDir, isSlug } from "../projects/store";
import { AutonomyStore } from "./store";

/**
 * The project's own folder under `<home>/projects`.
 *
 * NOTE: Resolved as the permission rules resolve theirs, so the dial sits
 * beside `permissions.json` and a project the session does not know is
 * refused rather than given a folder.
 */
async function projectFolder(project: string): Promise<string> {
  const { record, project: found } = await knownProject(project);
  if (!isSlug(found.slug)) throw new Error("That project key is not valid.");
  return join(accountDir(record), found.slug);
}

const store = new AutonomyStore({
  folderOf: projectFolder,
  changed: (project) =>
    broadcast(autonomyChannels.changed, {
      project,
    } satisfies AutonomyEvent),
});

/** `project`'s dial for main's own use, or null when it is not set. */
export function projectAutonomy(
  project: string,
): Promise<AutonomySettings | null> {
  return store.get(project);
}

export function registerAutonomy(devUrl: string | undefined): void {
  handle(
    autonomyChannels.get,
    devUrl,
    (args): Promise<AutonomySettings | null> => {
      const [project] = arity(args, 1, "A project is required");
      return store.get(slug(project));
    },
  );
  handle(
    autonomyChannels.set,
    devUrl,
    (args): Promise<AutonomySettings | null> => {
      const [project, settings] = arity(
        args,
        2,
        "A project and a level are required",
      );
      return store.set(slug(project), settings);
    },
  );
}
