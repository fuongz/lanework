import { create } from "zustand";

/**
 * Window layout intent that crosses more than one panel group.
 *
 * Its own store because the panels it speaks for live in different groups:
 * the rail is a panel of `AppShell`, the pull-request list is a panel of
 * `PullsLayout`, and neither group can reach into the other. A boolean here
 * lets one button collapse both.
 *
 * NOTE: Not persisted, unlike `usePreferences`. Focus mode hides the rail,
 * and the control that leaves it lives in a pull request's header. An app
 * reopened in focus mode on any other route would have no obvious way out.
 */
interface LayoutState {
  /** The diff has the window: rail and pull-request list are both hidden. */
  focusMode: boolean;
  toggleFocusMode: () => void;
  /**
   * Leave focus mode.
   *
   * Called when the pull-request screen goes away.
   */
  exitFocusMode: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  focusMode: false,
  toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
  exitFocusMode: () => set({ focusMode: false }),
}));
