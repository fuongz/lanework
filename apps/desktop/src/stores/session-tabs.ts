// The sessions open as tabs in the title bar (FE-144), per project.
//
// A tab is a conversation id: the chat route's `$conversation`. Opening a
// chat shows it in the project's one PREVIEW tab (drawn in italics), which
// the next chat opened replaces, as an editor's preview tab. It becomes a
// kept tab, there until closed, when its tab or its rail row is double
// clicked, or a message is sent in it. Kept tabs are saved on this machine
// across restarts; the preview is not.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How many tabs a project keeps: the oldest opened go first past it. */
const MAX_TABS = 24;

interface SessionTabs {
  /** Kept conversations, by project slug, in tab order. */
  bySlug: Record<string, string[]>;
  /** The preview tab's conversation, by project slug: one at most. */
  preview: Record<string, string>;
  /**
   * Shows `id` in the preview tab, unless it is kept already. The preview
   * it replaces closes.
   */
  show: (slug: string, id: string) => void;
  /** Keeps `id` at the end (its preview becomes a kept tab), unless kept. */
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
      preview: {},
      show: (slug, id) => {
        const { bySlug, preview } = get();
        if ((bySlug[slug] ?? []).includes(id) || preview[slug] === id) return;
        set({ preview: { ...preview, [slug]: id } });
      },
      open: (slug, id) => {
        const { bySlug, preview } = get();
        const tabs = bySlug[slug] ?? [];
        const rest = { ...preview };
        if (rest[slug] === id) delete rest[slug];
        set({
          bySlug: tabs.includes(id)
            ? bySlug
            : { ...bySlug, [slug]: [...tabs, id].slice(-MAX_TABS) },
          preview: rest,
        });
      },
      close: (slug, id) => {
        const tabs = get().bySlug[slug] ?? [];
        if (get().preview[slug] === id) {
          const rest = { ...get().preview };
          delete rest[slug];
          set({ preview: rest });
          // Drawn after the kept tabs: the last of them stands in.
          return tabs.at(-1) ?? null;
        }
        const at = tabs.indexOf(id);
        if (at < 0) return null;
        const next = tabs.filter((tab) => tab !== id);
        set({ bySlug: { ...get().bySlug, [slug]: next } });
        // The one to its right, as a browser does; the last one's left.
        return next[at] ?? get().preview[slug] ?? next[at - 1] ?? null;
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
