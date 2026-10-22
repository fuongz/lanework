/**
 * Reads `?project=<slug>` on Settings › Memory and Settings › Instructions.
 *
 * Settings is not inside a project, so the project whose files are open
 * travels in the search instead of the path.
 */
export function projectSearch(search: Record<string, unknown>): {
  project?: string;
} {
  return typeof search.project === "string" &&
    search.project.length > 0 &&
    search.project.length <= 200
    ? { project: search.project }
    : {};
}
