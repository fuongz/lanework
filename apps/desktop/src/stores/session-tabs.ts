// The sessions open as tabs in the title bar (FE-144), per project.
//
// A tab is a conversation id: the chat route's `$conversation`. It opens when
// that chat is opened and stays until it is closed, like a browser's, and the
// list is kept on this machine across restarts.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How many tabs a project keeps: the oldest opened go first past it. */
const MAX_TABS = 24;

interface SessionTabs {
  /** Open conversations, by project slug, in tab order. */
  bySlug: Record<string, string[]>;
  /** Adds `id` at the end, unless it is open already. */
  open: (slug: string, id: string) => void;
  /** Closes `id`; returns the tab to show instead, or null for none. */
  close: (slug: string, id: string) => string | null;
  /** Puts the project's tabs in `order` (a drag), keeping only open ones. */
  reorder: (slug: string, order: string[]) => void;
}

function readTabs(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [slug, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue;
    const kept = [
      ...new Set(ids.filter((id): id is string => typeof id === "string")),
    ];
    if (kept.length) out[slug] = kept.slice(-MAX_TABS);
  }
  return out;
}

export const useSessionTabs = create<SessionTabs>()(
  persist(
    (set, get) => ({
      bySlug: {},
      open: (slug, id) => {
        const tabs = get().bySlug[slug] ?? [];
        if (tabs.includes(id)) return;
        set({
          bySlug: { ...get().bySlug, [slug]: [...tabs, id].slice(-MAX_TABS) },
        });
      },
      close: (slug, id) => {
        const tabs = get().bySlug[slug] ?? [];
        const at = tabs.indexOf(id);
        if (at < 0) return null;
        const next = tabs.filter((tab) => tab !== id);
        set({ bySlug: { ...get().bySlug, [slug]: next } });
        // The one to its right, as a browser does; the last one's left.
        return next[at] ?? next[at - 1] ?? null;
      },
      reorder: (slug, order) => {
        const tabs = get().bySlug[slug] ?? [];
        const next = order.filter((id) => tabs.includes(id));
        if (next.length !== tabs.length) return;
        set({ bySlug: { ...get().bySlug, [slug]: next } });
      },
    }),
    {
      name: "lanework-session-tabs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ bySlug }) => ({ bySlug }),
      merge: (persisted, current) => ({
        ...current,
        bySlug: readTabs((persisted as { bySlug?: unknown } | null)?.bySlug),
      }),
    },
  ),
);
