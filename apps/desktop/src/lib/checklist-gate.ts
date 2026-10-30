// Whether a card may be worked yet, and what "approve the recommended options"
// would tick on it. No React, so a spec can hold it still.
import type { BoardChecklistItem } from "../../shared/projects";

/**
 * The mark an agent writes on the option it recommends: `(Recommended)` at
 * the start of a box (the MCP's own review flow), or `*(Recommended)*` at the
 * end (the old markdown cards).
 *
 * NOTE: Matched anywhere in the text and in any case, never as a field: the
 * board has no column for it, and the two spellings above are both live.
 */
const RECOMMENDED = /\(recommended\)/i;

function isRecommended(item: Pick<BoardChecklistItem, "text">): boolean {
  return RECOMMENDED.test(item.text);
}

/** One box "approve the recommended" would tick, and why. */
export interface GatePick {
  key: string;
  text: string;
  /** The "pick ONE" group it settles, or null for a decision on its own. */
  group: string | null;
}

export interface ChecklistGate {
  /** Every decision is settled: an agent may start on the card as it is. */
  ready: boolean;
  /**
   * What approving the recommendations ticks (FE-34/D5a): the recommended
   * option of each open group, then every open decision on its own — in the
   * order the card lists them.
   */
  picks: GatePick[];
  /**
   * Open groups with no single recommended option. Any of these and nothing
   * may be approved for the person: the choice is theirs to make.
   */
  blocked: string[];
}

/**
 * The card's decisions as AGENTS.md gates them.
 *
 * The same count as the service's `openDecisions`
 * (`packages/db/src/board/ops.ts`): an ungrouped decision not ticked, or a
 * group with no option ticked. Verify boxes never gate.
 */
export function checklistGate(
  items: readonly BoardChecklistItem[],
): ChecklistGate {
  const picks: GatePick[] = [];
  const blocked: string[] = [];
  const groups = new Map<string, BoardChecklistItem[]>();
  // NOTE: Collected first, then judged where each group FIRST appears, so a
  // group whose options are not next to each other is still one choice.
  for (const item of items) {
    if (item.section !== "decisions" || !item.group) continue;
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  const judged = new Set<string>();
  for (const item of items) {
    if (item.section !== "decisions") continue;
    if (!item.group) {
      if (!item.checked)
        picks.push({ key: item.key, text: item.text, group: null });
      continue;
    }
    if (judged.has(item.group)) continue;
    judged.add(item.group);
    const options = groups.get(item.group) ?? [];
    if (options.some((option) => option.checked)) continue;
    // NOTE: Exactly one. Two options both marked recommended is a card that
    // contradicts itself, and picking the first would be a guess.
    const recommended = options.filter(isRecommended);
    if (recommended.length === 1)
      picks.push({
        key: recommended[0].key,
        text: recommended[0].text,
        group: item.group,
      });
    else blocked.push(item.group);
  }
  return { ready: picks.length === 0 && blocked.length === 0, picks, blocked };
}
