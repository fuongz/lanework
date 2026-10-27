import { type LayoutStorage, useDefaultLayout } from "react-resizable-panels";
import { readStored, writeStored } from "#/lib/stored";

// Remembered pane widths for the `components/ui/resizable` panel groups.
//
// NOTE: Kept out of `components/ui/`, which a `shadcn add --overwrite` of
// `resizable` replaces wholesale. App code living there disappears on the
// next sync and breaks every screen that imports it.

/**
 * Storage for column widths that may be unavailable.
 *
 * NOTE: Always handed to the hook, never `undefined`. Handing it nothing
 * makes it reach for `localStorage` itself, which is what just threw.
 * `lib/stored.ts` wraps every read and write and falls back to memory: a
 * layout that forgets is an annoyance; an exception during render is a blank
 * window.
 */
function layoutStorage(): LayoutStorage {
  return {
    getItem: readStored,
    setItem: (key, value) => writeStored(key, value),
  };
}

/**
 * Remembered column widths.
 *
 * - `localStorage`, not the main process: one window's display preference is
 *   not account data and not worth an IPC round trip per drag.
 *   `stores/preferences.ts` keeps renderer preferences the same way.
 * - NOTE: `onlySaveAfterUserInteractions` matters. Without it, collapsing a
 *   panel from a button, or resizing the window, overwrites the width someone
 *   dragged to.
 */
export function usePersistedLayout(id: string, panelIds: string[]) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    panelIds,
    storage: layoutStorage(),
    onlySaveAfterUserInteractions: true,
  });
  return { defaultLayout, onLayoutChanged };
}
