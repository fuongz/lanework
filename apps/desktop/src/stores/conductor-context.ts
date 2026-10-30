import type { TeamLead } from "#/../shared/orchestration";

// A conductor's context files as they stand now (FE-96), for the prompt.
//
// Main says which paths are files, folders or gone; the gone ones are left
// out, so the conductor never goes looking for a file that is not there, and
// folders gain a trailing `/`. The saved conductor keeps every path: one that
// comes back is sent again.

/**
 * `lead` with only the context files still in `project`'s checkout. Without
 * a preload, or when main cannot answer, it is sent with none rather than not
 * at all.
 */
export async function withLiveContext(
  project: string,
  lead: TeamLead,
): Promise<TeamLead> {
  if (!lead.contextFiles.length) return lead;
  const surface = window.desktop?.leads;
  const entries = surface
    ? await surface.inspectContext(project, lead.contextFiles).catch(() => [])
    : [];
  return {
    ...lead,
    contextFiles: entries.flatMap((entry) =>
      entry.kind === "missing"
        ? []
        : [entry.kind === "folder" ? `${entry.path}/` : entry.path],
    ),
  };
}
