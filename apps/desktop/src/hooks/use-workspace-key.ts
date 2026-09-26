import { useBoard } from "#/stores/board";

/**
 * The terminal's key for a project — its cloud id, or its slug when the
 * service has none — which the pty host files every terminal and agent
 * under (FE-19, FE-26).
 */
export function useWorkspaceKey(slug: string | undefined): string | null {
  return useBoard((state) => {
    const found = slug
      ? state.workspaces.find((entry) => entry.slug === slug)
      : undefined;
    return found ? (found.id ?? found.slug) : null;
  });
}
