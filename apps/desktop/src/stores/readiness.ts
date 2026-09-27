import { useEffect } from "react";
import { create } from "zustand";
import type {
  ReadinessFix,
  ReadinessPreview,
  ReadinessReport,
} from "../../shared/readiness";

/**
 * How long a report stands before focusing the window asks again (FE-30/D9).
 *
 * ⚠️ Opening or switching to a project always asks; only focus is throttled.
 * Every check reads a handful of files, runs `git` once and makes one request,
 * and people flick between windows far more often than they edit AGENTS.md.
 */
const FOCUS_MIN_AGE_MS = 60_000;

/**
 * Whether each project's folder is ready for an agent (FE-30), as main last
 * reported it.
 *
 * ⚠️ Keyed by slug, so a report that lands after a switch is filed under the
 * project it was read for and never shown on the new one.
 */
interface ReadinessState {
  reports: Record<string, ReadinessReport>;
  errors: Record<string, string>;
  check: (slug: string, options?: { minAgeMs?: number }) => Promise<void>;
  preview: (slug: string, fix: ReadinessFix) => Promise<ReadinessPreview>;
  apply: (
    slug: string,
    fix: ReadinessFix,
    before: string | null,
  ) => Promise<void>;
}

/** A read that started before a later one for the same project must not land after it. */
const generation: Record<string, number> = {};
const askedAt: Record<string, number> = {};

function bump(slug: string): number {
  generation[slug] = (generation[slug] ?? 0) + 1;
  return generation[slug];
}

export const useReadiness = create<ReadinessState>((set) => ({
  reports: {},
  errors: {},
  check: async (slug, options = {}) => {
    const surface = window.desktop?.readiness;
    if (!surface) return;
    if (
      options.minAgeMs !== undefined &&
      Date.now() - (askedAt[slug] ?? 0) < options.minAgeMs
    )
      return;
    askedAt[slug] = Date.now();
    const mine = bump(slug);
    try {
      const report = await surface.check(slug);
      if (generation[slug] !== mine) return;
      set((state) => {
        const { [slug]: _, ...errors } = state.errors;
        return { reports: { ...state.reports, [slug]: report }, errors };
      });
    } catch (error) {
      if (generation[slug] !== mine) return;
      // ⚠️ A failed check is not a failed project: the last report stays, and
      // the error is only shown where somebody asked for the full list.
      set((state) => ({
        errors: {
          ...state.errors,
          [slug]:
            error instanceof Error
              ? error.message
              : "Could not check this project.",
        },
      }));
    }
  },
  preview: async (slug, fix) => {
    const surface = window.desktop?.readiness;
    if (!surface) throw new Error("Not available in this window.");
    return surface.preview(slug, fix);
  },
  apply: async (slug, fix, before) => {
    const surface = window.desktop?.readiness;
    if (!surface) throw new Error("Not available in this window.");
    const mine = bump(slug);
    const report = await surface.apply(slug, fix, before);
    askedAt[slug] = Date.now();
    if (generation[slug] !== mine) return;
    set((state) => ({ reports: { ...state.reports, [slug]: report } }));
  },
}));

/**
 * Check `slug` when it is opened or switched to, and again on window focus
 * once the last check is a minute old (FE-30/D9). Never on a timer.
 */
export function useReadinessWatch(slug: string | null): void {
  const check = useReadiness((state) => state.check);
  useEffect(() => {
    if (!slug) return;
    void check(slug);
    const onFocus = () => void check(slug, { minAgeMs: FOCUS_MIN_AGE_MS });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check, slug]);
}
