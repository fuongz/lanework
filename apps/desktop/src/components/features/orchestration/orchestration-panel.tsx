import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationAgent,
  OutgoingAttachment,
  Turn,
} from "#/../shared/conversation";
import type { OrchestrationRun } from "#/../shared/orchestration";
import { useModels } from "#/components/shared/conversation/composer.models";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  type DerivedProposal,
  deriveProposals,
  planningPrompt,
  proposalId,
  repairPrompt,
  visibleText,
  visibleTurns,
} from "#/lib/orchestration-prompt";
import { useProposalEdits } from "./orchestration-panel.store";
import { ProposalCard } from "./proposal-card";
import { RunPanel } from "./run-panel";

export { visibleText as orchestrationText };

type Send = (
  text: string,
  attachments: OutgoingAttachment[],
  names: { name: string; image: boolean }[],
) => Promise<boolean>;

/**
 * `/orchestrate` in a lead's chat (FE-87): the planning turn it sends, the
 * proposals read back out of the transcript, and the lead's runs.
 *
 * Mount it once per conversation page; hand the result to
 * {@link OrchestrationPanel}, `orchestrate` to the composer, and render
 * `turns` (not the raw ones) so the planning prompt shows as the user's
 * request and the proposal JSON stays out of the reply.
 */
export function useOrchestration({
  workspace,
  lead,
  leadAgent,
  turns,
  working,
  cwd,
  send,
}: {
  workspace: string | null;
  /** The lead's conversation id. */
  lead: string;
  /** Its CLI; null until the conversation is read. */
  leadAgent: ConversationAgent | null;
  /** The transcript's turns, as read. */
  turns: Turn[];
  /** A turn is open or the engine is running. */
  working: boolean;
  /** The checkout the lead runs in, so scopes come back relative to it. */
  cwd: string | null;
  /** The page's own send: the planning turn is an ordinary message. */
  send: Send;
}) {
  const sendRef = useRef(send);
  sendRef.current = send;
  const shown = useMemo(() => visibleTurns(turns), [turns]);
  // Codex's own model list arrives from main after the first read; a
  // proposal is checked again against it, not against the fallback list.
  const models = useModels();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-checked when the model list arrives.
  const proposals = useMemo(
    () => deriveProposals(turns, working),
    [turns, working, models],
  );
  // Sent, not yet in the transcript: drawn as planning meanwhile.
  const [pending, setPending] = useState<{
    id: string;
    request: string;
  } | null>(null);
  const landed = pending
    ? proposals.some((proposal) => proposal.id === pending.id)
    : false;
  useEffect(() => {
    if (landed) setPending(null);
  }, [landed]);

  const orchestrate = useCallback(
    async (
      request: string,
      attachments: OutgoingAttachment[] = [],
      names: { name: string; image: boolean }[] = [],
    ): Promise<boolean> => {
      if (!leadAgent || !request.trim()) return false;
      const id = proposalId();
      setPending({ id, request });
      const ok = await sendRef.current(
        planningPrompt(id, request.trim(), leadAgent, cwd),
        attachments,
        names,
      );
      if (!ok) setPending((current) => (current?.id === id ? null : current));
      return ok;
    },
    [leadAgent, cwd],
  );

  const repair = useCallback(
    async (proposal: DerivedProposal): Promise<boolean> => {
      if (!leadAgent || proposal.repaired) return false;
      return sendRef.current(
        repairPrompt(
          proposal.id,
          proposal.request,
          leadAgent,
          cwd,
          proposal.error ?? "The previous proposal was invalid.",
          proposal.response,
        ),
        [],
        [],
      );
    },
    [leadAgent, cwd],
  );

  // ─── The lead's runs ──────────────────────────────────────────────────────
  /** Null until the first read answered. */
  const [runs, setRuns] = useState<OrchestrationRun[] | null>(null);
  const upsert = useCallback(
    (run: OrchestrationRun) => {
      if (run.lead !== lead) return;
      setRuns((previous) => {
        const list = previous ?? [];
        const at = list.findIndex((entry) => entry.id === run.id);
        if (at === -1) return [...list, run];
        const next = list.slice();
        next[at] = run;
        return next;
      });
    },
    [lead],
  );
  useEffect(() => {
    const surface = window.desktop?.orchestration;
    if (!workspace || !surface) return;
    let gone = false;
    setRuns(null);
    void surface
      .runs(workspace)
      .then((list) => {
        if (!gone)
          setRuns(
            list
              .filter((run) => run.lead === lead)
              .sort((a, b) => a.createdAt - b.createdAt),
          );
      })
      // No runs to show is all a failed read costs here.
      .catch(() => {
        if (!gone) setRuns([]);
      });
    const off = surface.onChange((event) => {
      if (event.workspace === workspace) upsert(event.run);
    });
    return () => {
      gone = true;
      off();
    };
  }, [workspace, lead, upsert]);

  return {
    workspace,
    lead,
    leadAgent,
    /** The turns to draw: see {@link visibleTurns}. */
    turns: shown,
    proposals,
    pending,
    runs,
    orchestrate,
    repair,
    upsert,
  };
}

export type Orchestration = ReturnType<typeof useOrchestration>;

/**
 * The lead's proposal cards and runs, drawn after its transcript.
 *
 * The newest proposal is drawn as a card until it is approved; an approved
 * one is drawn as its run. Runs no card points to (another window approved
 * them, or the card was forgotten) follow at the end.
 */
export function OrchestrationPanel({
  slug,
  orchestration,
}: {
  slug: string;
  orchestration: Orchestration;
}) {
  const { workspace, lead, leadAgent, proposals, pending, runs } =
    orchestration;
  const edits = useProposalEdits((state) => state.edits);
  if (!workspace || !leadAgent) return null;

  const latest = proposals.at(-1);
  const linked = new Set<string>();
  const items = proposals.flatMap((proposal) => {
    const runId = edits[proposal.id]?.runId;
    if (runId) {
      linked.add(runId);
      const run = runs?.find((entry) => entry.id === runId);
      if (run)
        return [
          <RunPanel
            key={proposal.id}
            slug={slug}
            workspace={workspace}
            run={run}
            title={proposal.title}
            onRun={orchestration.upsert}
          />,
        ];
      if (runs === null)
        return [
          <ListSkeleton
            key={proposal.id}
            label="Reading the run"
            rows={3}
            className="border-border rounded-xl border"
          />,
        ];
    }
    if (proposal !== latest && !runId) return [];
    return [
      <ProposalCard
        key={proposal.id}
        workspace={workspace}
        lead={lead}
        leadAgent={leadAgent}
        proposal={proposal}
        onRepair={orchestration.repair}
        onApproved={orchestration.upsert}
      />,
    ];
  });

  if (pending && !proposals.some((proposal) => proposal.id === pending.id))
    items.push(
      <ProposalCard
        key={pending.id}
        workspace={workspace}
        lead={lead}
        leadAgent={leadAgent}
        proposal={{
          id: pending.id,
          request: pending.request,
          status: "planning",
          title: "",
          summary: "",
          tasks: [],
          error: null,
          response: "",
          repaired: false,
        }}
        onRepair={orchestration.repair}
        onApproved={orchestration.upsert}
      />,
    );

  for (const run of runs ?? [])
    if (!linked.has(run.id))
      items.push(
        <RunPanel
          key={run.id}
          slug={slug}
          workspace={workspace}
          run={run}
          title={null}
          onRun={orchestration.upsert}
        />,
      );

  if (!items.length) return null;
  return (
    <section aria-label="Orchestration" className="flex flex-col gap-3">
      {items}
    </section>
  );
}
