import { useEffect, useSyncExternalStore } from "react";
import {
  type AgentModel,
  allModels,
  onModelsChanged,
  setCodexModels,
} from "#/../shared/conversation";

/** Asked of main once per page load; every picker shares the answer. */
let asked = false;

/**
 * Every model the picker offers — Codex's as `codex` lists them in its own
 * cache, read by main — re-drawn when that list arrives.
 */
export function useModels(): readonly AgentModel[] {
  useEffect(() => {
    if (asked) return;
    asked = true;
    // `?.`: an older preload has no such call; the fallback list stays.
    void window.desktop?.conversation
      .codexModels?.()
      .then(setCodexModels)
      .catch(() => {
        asked = false;
      });
  }, []);
  return useSyncExternalStore(onModelsChanged, allModels);
}
