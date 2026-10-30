import { useBoard } from "#/stores/board";

/**
 * The terminal's key for a project: its cloud id, or its slug when the service
 * has none. The pty host files every terminal and agent under it.
 */
export function useProjectKey(slug: string | undefined): string | null {
  return useBoard((state) => {
    const found = slug
      ? state.projects.find((entry) => entry.slug === slug)
      : undefined;
    return found ? (found.id ?? found.slug) : null;
  });
}
