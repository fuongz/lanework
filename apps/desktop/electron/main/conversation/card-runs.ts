// Conversations started to work a card (FE-175): Assign to agent (FE-173).
//
// Their agent may call the Lanework board tools of the card workflow without
// a permission prompt, whatever its permission mode: reading the card,
// moving it, ticking what it proved and checkpointing are the work it was
// handed, and they only touch the board. Every other tool still asks as the
// mode says.
//
// NOTE: Held in memory only. A conversation resumed after the app restarts
// asks again, as any chat does; nothing on disk can widen what a chat may do.
// No Electron here: the engine reads it.

/** The board tools a card's agent works the card with. */
const CARD_TOOLS: ReadonlySet<string> = new Set(
  [
    "get_review",
    "set_status",
    "toggle_item",
    "checkpoint",
    "board_summary",
    "list_reviews",
    "list_boards",
    "lifecycle_status",
  ].map((tool) => `mcp__lanework__${tool}`),
);

/** `project\0conversation`, as the engines key them. */
const runs = new Set<string>();

const keyOf = (project: string, conversation: string) =>
  `${project}\0${conversation}`;

/** Mark `conversation` as one started for a card. */
export function markCardRun(project: string, conversation: string): void {
  runs.add(keyOf(project, conversation));
}

/**
 * Whether a permission request for `tool` in `conversation` is answered yes
 * without a card: a card run calling one of {@link CARD_TOOLS}.
 *
 * NOTE: Not `review_card` (it records the person's own answers), nor any
 * tool that creates, edits or deletes cards and boards.
 */
export function cardRunMayUse(
  project: string,
  conversation: string,
  tool: string,
): boolean {
  return CARD_TOOLS.has(tool) && runs.has(keyOf(project, conversation));
}
