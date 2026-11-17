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

/**
 * The key a model's order is kept under (FE-146): its CLI, or for OpenCode
 * its provider, the group Settings → Harness reorders it in.
 */
export function modelGroupKey(entry: AgentModel): string {
  return entry.agent === "opencode"
    ? `opencode:${entry.group ?? "Other"}`
    : entry.agent;
}

/**
 * `models` as the user arranged them (FE-146): each group where it was, its
 * models in the order kept for it (the ones it does not name after, in the
 * CLI's order) and, given `favorites`, the starred ones first.
 */
export function arrangeModels(
  models: readonly AgentModel[],
  order: Readonly<Record<string, readonly string[]>>,
  favorites?: readonly string[],
): AgentModel[] {
  const groups = new Map<string, AgentModel[]>();
  for (const entry of models) {
    const key = modelGroupKey(entry);
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  const starred = new Set(favorites ?? []);
  const out: AgentModel[] = [];
  for (const [key, list] of groups) {
    const rank = new Map((order[key] ?? []).map((id, at) => [id, at]));
    const place = (entry: AgentModel, at: number) =>
      rank.get(entry.id) ?? rank.size + at;
    const placed = list
      .map((entry, at) => ({ entry, at: place(entry, at) }))
      .sort((a, b) => a.at - b.at)
      .map(({ entry }) => entry);
    out.push(
      ...placed.filter((entry) => starred.has(entry.id)),
      ...placed.filter((entry) => !starred.has(entry.id)),
    );
  }
  return out;
}
