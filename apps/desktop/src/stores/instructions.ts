import { useEffect } from "react";
import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import type {
  EffectiveInstructions,
  InstructionAgent,
  InstructionContent,
  InstructionList,
} from "../../shared/instructions";

/**
 * What the open project's agents are told (FE-37), as main last listed it,
 * the files opened from it and each agent's whole reading.
 *
 * ⚠️ One project at a time, by slug: a listing that lands after a switch is
 * dropped rather than shown on the project now open.
 */
interface InstructionsState {
  slug: string | null;
  list: InstructionList | null;
  error: string | null;
  /** Bumped by every listing that lands: what the open views re-read on. */
  version: number;
  files: Record<string, InstructionContent>;
  fileErrors: Record<string, string>;
  effective: Partial<Record<InstructionAgent, EffectiveInstructions>>;
  effectiveErrors: Partial<Record<InstructionAgent, string>>;
  load: (slug: string) => Promise<void>;
  read: (slug: string, id: string) => Promise<void>;
  readEffective: (slug: string, agent: InstructionAgent) => Promise<void>;
  /** Show a file in Finder; throws what went wrong, to show. */
  reveal: (slug: string, id: string) => Promise<void>;
}

/** A listing that started before a later one must not land after it. */
let listing = 0;

export const useInstructions = create<InstructionsState>((set, get) => ({
  slug: null,
  list: null,
  error: null,
  version: 0,
  files: {},
  fileErrors: {},
  effective: {},
  effectiveErrors: {},
  load: async (slug) => {
    const surface = window.desktop?.instructions;
    if (!surface) return;
    if (get().slug !== slug)
      set({
        slug,
        list: null,
        error: null,
        files: {},
        fileErrors: {},
        effective: {},
        effectiveErrors: {},
      });
    const mine = ++listing;
    try {
      const list = await surface.list(slug);
      if (mine !== listing || get().slug !== slug) return;
      set((state) => ({ list, error: null, version: state.version + 1 }));
    } catch (error) {
      if (mine !== listing || get().slug !== slug) return;
      set({
        error: ipcMessage(error, "Could not read this project's instructions."),
      });
    }
  },
  read: async (slug, id) => {
    const surface = window.desktop?.instructions;
    if (!surface) return;
    try {
      const read = await surface.read(slug, id);
      if (get().slug !== slug) return;
      set((state) => {
        const { [id]: _, ...fileErrors } = state.fileErrors;
        return { files: { ...state.files, [id]: read }, fileErrors };
      });
    } catch (error) {
      if (get().slug !== slug) return;
      set((state) => ({
        fileErrors: {
          ...state.fileErrors,
          [id]: ipcMessage(error, "Could not read this file."),
        },
      }));
    }
  },
  readEffective: async (slug, agent) => {
    const surface = window.desktop?.instructions;
    if (!surface) return;
    try {
      const read = await surface.effective(slug, agent);
      if (get().slug !== slug) return;
      set((state) => {
        const { [agent]: _, ...effectiveErrors } = state.effectiveErrors;
        return {
          effective: { ...state.effective, [agent]: read },
          effectiveErrors,
        };
      });
    } catch (error) {
      if (get().slug !== slug) return;
      set((state) => ({
        effectiveErrors: {
          ...state.effectiveErrors,
          [agent]: ipcMessage(error, "Could not gather what it reads."),
        },
      }));
    }
  },
  reveal: async (slug, id) => {
    const surface = window.desktop?.instructions;
    if (!surface) throw new Error("Not available in this window.");
    try {
      await surface.reveal(slug, id);
    } catch (error) {
      throw new Error(ipcMessage(error, "Could not show this file in Finder."));
    }
  },
}));

/**
 * List `slug`'s instructions while the screen is open, again on window
 * focus, and every time main says one of their folders was written
 * (FE-37/D7). Never on a timer.
 */
export function useInstructionsWatch(slug: string): void {
  const load = useInstructions((state) => state.load);
  useEffect(() => {
    void load(slug);
    const onFocus = () => void load(slug);
    window.addEventListener("focus", onFocus);
    const off = window.desktop?.instructions.onChange((change) => {
      if (change.workspace === slug) void load(slug);
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      off?.();
    };
  }, [load, slug]);
}
