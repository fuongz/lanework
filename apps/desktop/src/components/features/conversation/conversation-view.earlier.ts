// What the chat reads of a conversation's turns before the window it holds
// (`Conversation.summary`): main's read sends only the newest turns, and a
// proposal or run planned before them must still show as with all of them.
import { useMemo } from "react";
import type { ConversationSummary, Turn } from "#/../shared/conversation";
import type { OrchestrationRun } from "#/../shared/orchestration";
import type { DerivedProposal } from "#/../shared/orchestration-proposals";
import {
  proposalRun,
  useProposalEdits,
} from "../orchestration/orchestration-panel.store";

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * What {@link useEarlierRuns} reads of the panel's orchestration.
 *
 * NOTE: Only its shape, not the panel's own type: importing that would make
 * this file a second importer of the panel, which belongs in `features/`
 * only while one file uses it.
 */
interface EarlierInput {
  proposals: DerivedProposal[];
  runs: OrchestrationRun[] | null | undefined;
}

/**
 * The turns proposals are read from: the newest earlier proposal's own turns
 * ({@link ConversationSummary.anchor}) before the ones held, and their ids,
 * which are never drawn.
 *
 * NOTE: That proposal may be the conversation's latest: its card (Approve
 * above the prompt, or a broken one's Repair) is drawn whatever turns are
 * on screen, and is read from its turns with the page's own leads. Its
 * turns the page already holds, once paged in, are not laid twice.
 */
export function useAnchoredTurns(
  turns: Turn[],
  summary: ConversationSummary | undefined,
): { planned: Turn[]; anchored: ReadonlySet<string> } {
  return useMemo(() => {
    if (!summary?.anchor.length) return { planned: turns, anchored: NO_IDS };
    const held = new Set(turns.map((turn) => turn.id));
    const anchor = summary.anchor.filter((turn) => !held.has(turn.id));
    if (!anchor.length) return { planned: turns, anchored: NO_IDS };
    return {
      planned: [...anchor, ...turns],
      anchored: new Set(anchor.map((turn) => turn.id)),
    };
  }, [turns, summary]);
}

/** `turns` without the anchor's: what is drawn. */
export function drawnTurns(
  turns: Turn[],
  anchored: ReadonlySet<string>,
): Turn[] {
  return anchored.size ? turns.filter((turn) => !anchored.has(turn.id)) : turns;
}

/**
 * Runs that will not change again, drawn in place after their proposal's
 * reply.
 *
 * NOTE: Mirrors `SETTLED_RUNS` in `orchestration-panel.tsx`, which does not
 * export it.
 */
const SETTLED: readonly OrchestrationRun["status"][] = ["finished", "stopped"];

/**
 * The orchestration as the panel after the transcript and the Sessions
 * panel's run list take it, with the proposals planned before the window
 * ({@link ConversationSummary.proposals}) the page derived none of.
 *
 * - `panel`: a settled run of one is left out. With every turn held it is
 *   drawn after its reply, and that reply is not on screen yet: it shows
 *   once paged in, as a run after a folded compaction does. An active or
 *   paused one keeps its title at the chat's end, as it would.
 * - `lead`: every one, so each run in the list keeps its title.
 *
 * NOTE: Without them, the panel took each of those runs for one no
 * proposal points to and drew it at the chat's end, untitled.
 */
export function useEarlierRuns<Orchestration extends EarlierInput>(
  orchestration: Orchestration,
  summary: ConversationSummary | undefined,
): { panel: Orchestration; lead: Orchestration } {
  const edits = useProposalEdits((state) => state.edits);
  return useMemo(() => {
    const same = { panel: orchestration, lead: orchestration };
    if (!summary?.proposals.length) return same;
    const derived = new Set(
      orchestration.proposals.map((proposal) => proposal.id),
    );
    const stubs = summary.proposals
      .filter((proposal) => !derived.has(proposal.id))
      .map(
        (proposal): DerivedProposal => ({
          id: proposal.id,
          request: "",
          status: "ready",
          title: proposal.title,
          summary: "",
          tasks: [],
          error: null,
          response: "",
          // Never offered a repair: it is not the latest.
          repaired: true,
          teamLead: null,
          afterTurn: proposal.afterTurn,
        }),
      );
    if (!stubs.length) return same;
    const runs = orchestration.runs;
    const going: DerivedProposal[] = [];
    const settled = new Set<string>();
    for (const stub of stubs) {
      const runId = proposalRun(stub.id, edits, runs);
      const run = runId ? runs?.find((entry) => entry.id === runId) : null;
      // No run, or none read yet: an older proposal draws nothing.
      if (!run) continue;
      if (SETTLED.includes(run.status)) settled.add(run.id);
      else going.push(stub);
    }
    return {
      panel: {
        ...orchestration,
        proposals: [...going, ...orchestration.proposals],
        runs:
          runs && settled.size
            ? runs.filter((run) => !settled.has(run.id))
            : runs,
      },
      lead: {
        ...orchestration,
        proposals: [...stubs, ...orchestration.proposals],
      },
    };
  }, [orchestration, summary, edits]);
}
