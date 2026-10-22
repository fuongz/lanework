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
 * Every model the picker offers, re-drawn when Codex's list arrives.
 *
 * Codex's models are the ones `codex` lists in its own cache, read by main.
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
