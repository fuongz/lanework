import { useEffect, useSyncExternalStore } from "react";
import {
  type AgentModel,
  allModels,
  onModelsChanged,
  setClaudeModels,
  setCodexModels,
  setOpenCodeModels,
} from "#/../shared/conversation";

/**
 * The shortest gap between two asks of main: every picker mounted at once
 * shares one (FE-135/D3).
 */
const ASK_AGAIN_MS = 10_000;
/** When main was last asked for each CLI's list; 0 to ask on next use. */
const asked = { claude: 0, codex: 0, opencode: 0 };

/** Ask main for `cli`'s list unless it was asked a moment ago. */
function ask(
  cli: keyof typeof asked,
  read: (() => Promise<AgentModel[]>) | undefined,
  take: (list: AgentModel[]) => void,
): void {
  // `?.`: an older preload has no such call; the fallback list stays.
  if (!read || Date.now() - asked[cli] < ASK_AGAIN_MS) return;
  asked[cli] = Date.now();
  void read()
    .then(take)
    .catch(() => {
      asked[cli] = 0;
    });
}

/**
 * Every model the picker offers, re-drawn when a CLI's list arrives.
 *
 * Main is asked again each time a picker mounts (opens), at most once in
 * {@link ASK_AGAIN_MS} (FE-135/D3):
 *
 * - Claude's are the ones `claude` lists, kept by main and asked of the CLI
 *   again behind it when due.
 * - Codex's are the ones `codex` lists in its own cache, read by main.
 * - OpenCode's are the providers' models its service lists (FE-104); empty
 *   when OpenCode is missing or has none, so none is offered.
 */
export function useModels(): readonly AgentModel[] {
  useEffect(() => {
    const surface = window.desktop?.conversation;
    ask("claude", surface?.claudeModels, setClaudeModels);
    ask("codex", surface?.codexModels, setCodexModels);
    ask("opencode", surface?.opencodeModels, (list) => {
      setOpenCodeModels(list);
      // None yet may be a service still starting: ask again next time.
      if (list.length === 0) asked.opencode = 0;
    });
  }, []);
  return useSyncExternalStore(onModelsChanged, allModels);
}
