// Permission rules (FE-165): the page's calls, and the store every engine's
// gate reads.
//
// Registering does no work: the store reads a project's file on the first
// request or call for it.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AutoAllowEntry,
  type PermissionRule,
  type PermissionsEvent,
  permissionsChannels,
} from "../../../shared/permissions";
import type { PendingPermissionCard } from "../conversation";
import { broadcast, handle } from "../ipc";
import { arity, id, slug } from "../ipc-args";
import { knownProject } from "../projects/session";
import { accountDir, isSlug } from "../projects/store";
import { installPermissions, subjectOf } from "./gate";
import { suggestRule } from "./matcher";
import { PermissionStore } from "./store";

/** The project's own folder under `<home>/projects`. */
async function projectFolder(project: string): Promise<string> {
  const { record, project: found } = await knownProject(project);
  if (!isSlug(found.slug)) throw new Error("That project key is not valid.");
  return join(accountDir(record), found.slug);
}

const store = new PermissionStore({
  folderOf: projectFolder,
  changed: (project) =>
    broadcast(permissionsChannels.changed, {
      project,
    } satisfies PermissionsEvent),
});

/** Write the audit lists still waiting: the app is quitting. */
export function flushPermissions(): Promise<void> {
  return store.flush();
}

export interface PermissionsDeps {
  /** A card a conversation shows now (`conversation.pendingPermission`). */
  pendingPermission: (
    project: unknown,
    conversation: unknown,
    id: string,
  ) => Promise<PendingPermissionCard | null>;
}

/** The Allow rule card `requestId` of a conversation would save. */
async function suggestFor(
  deps: PermissionsDeps,
  project: unknown,
  conversation: unknown,
  requestId: string,
): Promise<{ project: string; rule: PermissionRule } | null> {
  const card = await deps.pendingPermission(project, conversation, requestId);
  if (!card) return null;
  const subject = subjectOf(card.request);
  if (!subject) return null;
  const suggested = suggestRule(subject, {
    checkout: card.folder,
    home: homedir(),
  });
  if (!suggested) return null;
  return {
    project: card.project,
    rule: {
      id: `rule:${randomUUID()}`,
      effect: "allow",
      ...suggested,
      createdAt: new Date().toISOString(),
    },
  };
}

export function registerPermissions(
  devUrl: string | undefined,
  deps: PermissionsDeps,
): void {
  installPermissions(store);
  handle(
    permissionsChannels.list,
    devUrl,
    (args): Promise<PermissionRule[]> => {
      const [project] = arity(args, 1, "A project is required");
      return store.list(slug(project));
    },
  );
  handle(
    permissionsChannels.save,
    devUrl,
    (args): Promise<PermissionRule[]> => {
      const [project, rule] = arity(
        args,
        2,
        "A project and a rule are required",
      );
      return store.save(slug(project), rule);
    },
  );
  handle(
    permissionsChannels.remove,
    devUrl,
    (args): Promise<PermissionRule[]> => {
      const [project, ruleId] = arity(
        args,
        2,
        "A project and a rule id are required",
      );
      return store.remove(
        slug(project),
        id(ruleId, "A valid rule id is required"),
      );
    },
  );
  handle(
    permissionsChannels.audit,
    devUrl,
    (args): Promise<AutoAllowEntry[]> => {
      const [project] = arity(args, 1, "A project is required");
      return store.audit(slug(project));
    },
  );
  handle(
    permissionsChannels.suggest,
    devUrl,
    async (args): Promise<PermissionRule | null> => {
      const [project, conversation, requestId] = arity(
        args,
        3,
        "A project, a conversation and a request are required",
      );
      return (
        (await suggestFor(deps, project, conversation, id(requestId)))?.rule ??
        null
      );
    },
  );
  handle(
    permissionsChannels.allowCard,
    devUrl,
    async (args): Promise<PermissionRule[] | null> => {
      const [project, conversation, requestId] = arity(
        args,
        3,
        "A project, a conversation and a request are required",
      );
      // NOTE: Saved for the card's own project, as its conversation names
      // it, so the conversation that raised it is the one the rule answers.
      const found = await suggestFor(
        deps,
        project,
        conversation,
        id(requestId),
      );
      return found ? store.save(found.project, found.rule) : null;
    },
  );
}
