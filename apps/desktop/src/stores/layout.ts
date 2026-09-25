import { create } from "zustand";

/**
 * Window layout intent that crosses more than one panel group.
 *
 * ⚠️ Its own store because the panels it speaks for live in DIFFERENT groups:
 * the rail is a panel of `AppShell`, the pull-request list is a panel of
 * `PullsLayout`, and neither group can reach into the other. A boolean here is
 * what lets one button collapse both.
 *
 * ⚠️ NOT persisted, unlike `usePreferences`. Focus mode hides the rail, and the
 * control that leaves it lives in a pull request's header — so a machine that
 * reopened the app already in focus mode, on any other route, would have no
 * obvious way out. It is a mode for the next few minutes, not a setting.
 */
interface LayoutState {
  /** The diff has the window: rail and pull-request list are both hidden. */
  focusMode: boolean;
  toggleFocusMode: () => void;
  /** Leave focus mode. Called when the pull-request screen goes away. */
  exitFocusMode: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  focusMode: false,
  toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
  exitFocusMode: () => set({ focusMode: false }),
}));
