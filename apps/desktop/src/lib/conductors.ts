// Conductors (FE-95): team leads with a conversation of their own in each
// project, as Monocode's Monos have. The lead's preset is the conductor; its
// conversation is whichever agent session main marked as its own.

import type { LeadsList, TeamLead } from "#/../shared/orchestration";
import type { AgentSession } from "#/../shared/terminal";
import type { NewChat } from "#/stores/new-chats";

/** The conductors as the rail lists them: the default first, then by name. */
export function orderConductors(list: LeadsList | null): TeamLead[] {
  if (!list) return [];
  return [...list.leads].sort((a, b) => {
    if (a.id === list.defaultId) return -1;
    if (b.id === list.defaultId) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * A conductor's own conversation in `project`: the listed session main
 * marked as its own, else one just started that the listing has not caught
 * up with. Null when it has none yet.
 */
export function conductorConversation(
  sessions: readonly AgentSession[] | undefined,
  started: Readonly<Record<string, NewChat>>,
  project: string,
  conductor: string,
): string | null {
  const own = (sessions ?? [])
    .filter((session) => session.conductor === conductor)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (own) return own.id;
  for (const [id, chat] of Object.entries(started))
    if (chat.project === project && chat.conductor === conductor) return id;
  return null;
}
