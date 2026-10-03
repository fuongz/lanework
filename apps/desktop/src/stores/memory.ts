import { useEffect } from "react";
import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type { MemoryEntry, MemoryFile, MemoryList } from "../../shared/memory";
import { MEMORY_INDEX } from "../../shared/memory";

/**
 * What Claude remembers about the open project (FE-36), as main last listed
 * it, and the memories opened from it.
 *
 * ⚠️ One project at a time, by slug: a listing that lands after a switch is
 * dropped rather than shown on the project now open.
 */
interface MemoryState {
  slug: string | null;
  list: MemoryList | null;
  error: string | null;
  /** Opened memories by file, each as read at the `mtimeMs` it carries. */
  files: Record<string, MemoryFile>;
  fileErrors: Record<string, string>;
  load: (slug: string) => Promise<void>;
  read: (slug: string, file: string) => Promise<void>;
  /** Open the memory folder in Finder; throws what went wrong, to show. */
  reveal: (slug: string) => Promise<void>;
}

/** A listing that started before a later one must not land after it. */
let listing = 0;

export const useMemory = create<MemoryState>((set, get) => ({
  slug: null,
  list: null,
  error: null,
  files: {},
  fileErrors: {},
  load: async (slug) => {
    const surface = window.desktop?.memory;
    if (!surface) return;
    if (get().slug !== slug)
      set({ slug, list: null, error: null, files: {}, fileErrors: {} });
    const mine = ++listing;
    try {
      const list = await surface.list(slug);
      if (mine !== listing || get().slug !== slug) return;
      set({ list, error: null });
    } catch (error) {
      if (mine !== listing || get().slug !== slug) return;
      set({
        error: ipcMessage(error, "Could not read this project's memory."),
      });
    }
  },
  read: async (slug, file) => {
    const surface = window.desktop?.memory;
    if (!surface) return;
    try {
      const read = await surface.read(slug, file);
      if (get().slug !== slug) return;
      set((state) => {
        const { [file]: _, ...fileErrors } = state.fileErrors;
        return { files: { ...state.files, [file]: read }, fileErrors };
      });
    } catch (error) {
      if (get().slug !== slug) return;
      set((state) => ({
        fileErrors: {
          ...state.fileErrors,
          [file]: ipcMessage(error, "Could not read this memory."),
        },
      }));
    }
  },
  reveal: async (slug) => {
    const surface = window.desktop?.memory;
    if (!surface) throw new Error("Not available in this window.");
    try {
      await surface.reveal(slug);
    } catch (error) {
      throw new Error(ipcMessage(error, "Could not open the memory folder."));
    }
  },
}));

/** The memories Claude saved, the index left out: what the rail counts. */
export function memoryCount(list: MemoryList | null): number {
  return (
    list?.entries.filter((entry) => entry.file !== MEMORY_INDEX).length ?? 0
  );
}

export function memoryEntry(
  list: MemoryList | null,
  file: string,
): MemoryEntry | null {
  return list?.entries.find((entry) => entry.file === file) ?? null;
}

/**
 * List `slug`'s memory when it is opened, again on window focus, and every
 * time main says its folder was written (FE-36/D11). Never on a timer.
 *
 * ⚠️ Called by the RAIL, so its count is right before Memory is opened and
 * stays right while it is not.
 */
export function useMemoryWatch(slug: string | undefined): void {
  const load = useMemory((state) => state.load);
  useEffect(() => {
    if (!slug) return;
    void load(slug);
    const onFocus = () => void load(slug);
    window.addEventListener("focus", onFocus);
    const off = window.desktop?.memory.onChange((change) => {
      if (change.workspace === slug) void load(slug);
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      off?.();
    };
  }, [load, slug]);
}
