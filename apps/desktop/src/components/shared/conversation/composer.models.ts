import { useEffect, useSyncExternalStore } from "react";
import {
  type AgentModel,
  allModels,
  onModelsChanged,
  setCodexModels,
  setOpenCodeModels,
} from "#/../shared/conversation";

/** Asked of main once per page load; every picker shares the answer. */
let asked = false;
/** OpenCode's, asked apart: its service may be slow, or fail alone. */
let askedOpenCode = false;

/**
 * Every model the picker offers, re-drawn when Codex's or OpenCode's list
 * arrives.
 *
 * Codex's models are the ones `codex` lists in its own cache, read by main.
 * OpenCode's are the providers' models its service lists (FE-104); empty when
 * OpenCode is missing or has none, so none is offered.
 */
export function useModels(): readonly AgentModel[] {
  useEffect(() => {
    const surface = window.desktop?.conversation;
    if (!asked) {
      asked = true;
      // `?.`: an older preload has no such call; the fallback list stays.
      void surface
        ?.codexModels?.()
        .then(setCodexModels)
        .catch(() => {
          asked = false;
        });
    }
    if (!askedOpenCode) {
      askedOpenCode = true;
      void surface
        ?.opencodeModels?.()
        .then((list) => {
          setOpenCodeModels(list);
          // None yet may be a service still starting: ask again next time.
          if (list.length === 0) askedOpenCode = false;
        })
        .catch(() => {
          askedOpenCode = false;
        });
    }
  }, []);
  return useSyncExternalStore(onModelsChanged, allModels);
}
