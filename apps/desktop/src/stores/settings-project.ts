import { useEffect } from "react";
import { create } from "zustand";
import type { Project } from "#/../shared/projects";
import { useBoard } from "#/stores/board";

/**
 * Which project the Settings pages with a scope row are about (FE-145).
 *
 * Picked in each page's "Applying settings for" row and shared by Skills, MCP
 * and Archived, so moving between them keeps it.
 *
 * `all` is Skills' and MCP's "All projects": the user's own skills and
 * servers rather than one project's. It is kept apart from `picked` so
 * choosing it there does not lose the project Archived (which has no "All
 * projects") is showing.
 *
 * Local to Settings. Picking a project here does not switch to it: the app's
 * open project stays where it was.
 */
export const useSettingsProjectPick = create<{
  picked: string | null;
  /** Skills and MCP show what every project gets. The default. */
  all: boolean;
  /** Picks one project, which also leaves "All projects". */
  pick: (slug: string) => void;
  setAll: (all: boolean) => void;
}>((set) => ({
  picked: null,
  all: true,
  pick: (slug) => set({ picked: slug, all: false }),
  setAll: (all) => set({ all }),
}));

/**
 * The project the scoped Settings pages show.
 *
 * Reads the project list from {@link useBoard} on a cold start.
 *
 * @returns The picked project, else the one open in the app, else the
 * first. Null when there are none, or they are still being read.
 */
export function useSettingsProject(): Project | null {
  const picked = useSettingsProjectPick((state) => state.picked);
  const projects = useBoard((state) => state.projects);
  const active = useBoard((state) => state.active?.slug ?? null);
  const ready = useBoard((state) => state.ready);
  const hydrate = useBoard((state) => state.hydrate);
  // Settings can be opened straight from a cold start, with nothing loaded.
  useEffect(() => {
    if (!ready) void hydrate();
  }, [ready, hydrate]);
  return (
    projects.find((project) => project.slug === picked) ??
    projects.find((project) => project.slug === active) ??
    projects[0] ??
    null
  );
}
