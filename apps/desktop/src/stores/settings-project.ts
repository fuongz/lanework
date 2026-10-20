import { useEffect } from "react";
import { create } from "zustand";
import type { Workspace } from "#/../shared/workspaces";
import { useBoard } from "#/stores/board";

/**
 * The project Settings › Projects is about: picked in the group's heading and
 * shared by General, Skills and MCP, so moving between them keeps it.
 *
 * ⚠️ Settings-local on purpose. Picking a project to look after here is not
 * switching to it — the app's own open project stays where it was.
 */
export const useSettingsProjectPick = create<{
  picked: string | null;
  pick: (slug: string) => void;
}>((set) => ({
  picked: null,
  pick: (slug) => set({ picked: slug }),
}));

/**
 * The picked project, else the one open in the app, else the first — or null
 * when there are none (or they are still being read).
 */
export function useSettingsProject(): Workspace | null {
  const picked = useSettingsProjectPick((state) => state.picked);
  const workspaces = useBoard((state) => state.workspaces);
  const active = useBoard((state) => state.active?.slug ?? null);
  const ready = useBoard((state) => state.ready);
  const hydrate = useBoard((state) => state.hydrate);
  // Settings can be opened straight from a cold start, with nothing loaded.
  useEffect(() => {
    if (!ready) void hydrate();
  }, [ready, hydrate]);
  return (
    workspaces.find((workspace) => workspace.slug === picked) ??
    workspaces.find((workspace) => workspace.slug === active) ??
    workspaces[0] ??
    null
  );
}
