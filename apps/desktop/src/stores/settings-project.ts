import { useEffect } from "react";
import { create } from "zustand";
import type { Project } from "#/../shared/projects";
import { useBoard } from "#/stores/board";

/**
 * The project Settings › Projects is about.
 *
 * Picked in the group's heading and shared by General, Skills and MCP, so
 * moving between them keeps it.
 *
 * Local to Settings. Picking a project here does not switch to it: the app's
 * open project stays where it was.
 */
export const useSettingsProjectPick = create<{
  picked: string | null;
  pick: (slug: string) => void;
}>((set) => ({
  picked: null,
  pick: (slug) => set({ picked: slug }),
}));

/**
 * The project Settings › Projects shows.
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
