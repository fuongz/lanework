import { useEffect } from "react";
import { create } from "zustand";
import { ipcMessage } from "#/lib/ipc-error";
import { findDesktopSurface } from "#/server/desktop";
import type { AutonomySettings } from "../../shared/autonomy";

/**
 * Each project's autonomy dial (PD-08), as main last reported it.
 *
 * Keyed by project slug, as the IPC is. A slug absent from `dials` has not
 * been read yet; null means the dial is not set there.
 */
interface AutonomyState {
  dials: Record<string, AutonomySettings | null>;
  errors: Record<string, string>;
  /** Read a project's dial; also starts following main's changes. */
  load: (slug: string) => Promise<void>;
  /**
   * Set a project's dial, or clear it with null. Shown at once; put back to
   * what main holds when it refuses.
   *
   * @returns Why it failed, or null.
   */
  set: (
    slug: string,
    settings: AutonomySettings | null,
  ) => Promise<string | null>;
}

/**
 * Request tickets, by slug: a read that started before a later one (or a
 * set) for the same project must not land after it.
 */
const generation: Record<string, number> = {};
function bump(slug: string): number {
  generation[slug] = (generation[slug] ?? 0) + 1;
  return generation[slug];
}

let unwatch: (() => void) | null = null;

export const useAutonomy = create<AutonomyState>((set, get) => {
  function store(slug: string, dial: AutonomySettings | null) {
    set((state) => {
      const { [slug]: _, ...errors } = state.errors;
      return { dials: { ...state.dials, [slug]: dial }, errors };
    });
  }
  function fail(slug: string, message: string) {
    set((state) => ({ errors: { ...state.errors, [slug]: message } }));
  }

  /** Main says a dial changed: read it again where it was read before. */
  function watch() {
    if (unwatch) return;
    const surface = findDesktopSurface("autonomy");
    if (!surface) return;
    unwatch = surface.onChanged(({ project }) => {
      if (project in get().dials) void get().load(project);
    });
  }

  return {
    dials: {},
    errors: {},

    load: async (slug) => {
      const surface = findDesktopSurface("autonomy");
      if (!surface) {
        fail(slug, "The autonomy level is not available in this window.");
        return;
      }
      watch();
      const mine = bump(slug);
      try {
        const dial = await surface.get(slug);
        if (generation[slug] === mine) store(slug, dial);
      } catch (error) {
        if (generation[slug] === mine)
          fail(slug, ipcMessage(error, "Could not read the autonomy level."));
      }
    },

    set: async (slug, settings) => {
      const surface = findDesktopSurface("autonomy");
      if (!surface) return "Not available in this window.";
      watch();
      const mine = bump(slug);
      store(slug, settings);
      try {
        const saved = await surface.set(slug, settings);
        if (generation[slug] === mine) store(slug, saved);
        return null;
      } catch (error) {
        const message = ipcMessage(error, "Could not save the autonomy level.");
        if (generation[slug] === mine) {
          void get().load(slug);
          fail(slug, message);
        }
        return message;
      }
    },
  };
});

/**
 * A project's dial, read on first use and kept in step with main.
 *
 * @returns The dial, null when it is not set, or undefined while it is read
 *   (and always without a slug).
 */
export function useProjectAutonomy(
  slug: string | null | undefined,
): AutonomySettings | null | undefined {
  const dial = useAutonomy((state) => (slug ? state.dials[slug] : undefined));
  const load = useAutonomy((state) => state.load);
  useEffect(() => {
    if (slug) void load(slug);
  }, [slug, load]);
  return dial;
}
