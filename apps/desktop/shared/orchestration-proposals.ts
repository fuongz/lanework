// A proposal read back out of a transcript (FE-87, FE-95): the envelopes
// that mark a planning turn, the lead's reply checked against the catalog,
// and the proposals a conversation holds.
//
// NOTE: Shared, not the page's own: main answers a conductor's latest ready
// proposal (`conversation.latestProposal`) from its cached transcript, and
// the card draws the same proposals from the chat's turns. One reading, so
// the rail's dot and the card never disagree. Nothing here may import from
// the page (icons, stores): main bundles it too.

import {
  allModels,
  type ConversationAgent,
  modelName,
  OPENCODE_MODEL_ID,
  type Turn,
} from "./conversation";
import {
  type ProposedTask,
  parseProposedTasks,
  type TeamLead,
  TITLE_MAX,
} from "./orchestration";

const SUMMARY_MAX = 2000;

const OPEN = "<lanework_orchestrate";
const CLOSE = "</lanework_orchestrate>";
const ENVELOPE =
  /^<lanework_orchestrate id="([A-Za-z0-9_-]{1,64})" kind="(plan|repair)"(?: lead="((?:repo:)?[a-z0-9][a-z0-9-]{0,47})")?>\n([\s\S]*)\n<\/lanework_orchestrate>(?:\s+(@[\s\S]*))?$/;
// A tag right after a backtick is one quoted in inline code (a reply that
// talks about proposals), not a proposal: neither read nor hidden.
export const PROPOSAL_TAG =
  /(?<!`)<lanework_proposal>\s*([\s\S]*?)\s*<\/lanework_proposal>/g;
/** A proposal block still being streamed: from its tag to the end. */
export const PROPOSAL_OPEN = /(?<!`)<lanework_proposal>[\s\S]*$/;
/** A reply that opens a proposal, not one that only names the tag. */
const PROPOSAL_MARK = /(?<!`)<lanework_proposal>/;

/** What the user sent, as the transcript has it. */
export interface Envelope {
  /** The proposal it plans or repairs. */
  id: string;
  kind: "plan" | "repair";
  /** What the user asked for. */
  request: string;
  /** The team lead it was planned under, by id; null for none (FE-87). */
  lead: string | null;
  /**
   * The files attached to it, as the `@path` mentions main writes after the
   * envelope for every file that is not an image; "" for none.
   */
  attached: string;
}

/** A model a task may name, as the prompt lists it and the card offers it. */
export interface CatalogEntry {
  agent: ConversationAgent;
  model: string;
  label: string;
}

/**
 * The models a task may name: the team lead's workers, or without one the
 * picker's current ones, not the legacy.
 */
export function catalog(lead: TeamLead | null = null): CatalogEntry[] {
  if (lead?.workers.length)
    return lead.workers.map((worker) => ({
      agent: worker.agent,
      model: worker.model,
      label: modelName(worker.model) ?? worker.model,
    }));
  return allModels()
    .filter((entry) => !entry.legacy)
    .map((entry) => ({
      agent: entry.agent,
      model: entry.id,
      label: entry.label,
    }));
}

/** Whether a task may leave its model to the tier under `lead`. */
export function tiersAllowed(lead: TeamLead | null): boolean {
  return (
    !lead?.workers.length || lead.workers.some((worker) => worker.tier !== null)
  );
}

/** The envelope `text` is, or null for a message the user typed. */
export function readEnvelope(text: string): Envelope | null {
  if (!text.startsWith(OPEN)) return null;
  const match = ENVELOPE.exec(text.trim());
  if (!match) return null;
  const body = match[4] ?? "";
  // The request is the last block: whatever it holds, it ends the body.
  const start = body.lastIndexOf("<user_request>\n");
  const end = body.lastIndexOf("\n</user_request>");
  if (start === -1 || end < start) return null;
  return {
    id: match[1] ?? "",
    kind: match[2] === "repair" ? "repair" : "plan",
    request: body.slice(start + "<user_request>\n".length, end),
    lead: match[3] ?? null,
    attached: match[5] ?? "",
  };
}

export const CONDUCTOR_OPEN = "<lanework_conductor";
export const CONDUCTOR_CLOSE = "</lanework_conductor>";
const CONDUCTOR_ENVELOPE =
  /^<lanework_conductor id="([A-Za-z0-9_-]{1,64})" lead="((?:repo:)?[a-z0-9][a-z0-9-]{0,47})" context="([a-z0-9]{1,16})">\n([\s\S]*)\n<\/lanework_conductor>(?:\s+(@[\s\S]*))?$/;

/** A message the user sent to a conductor, as the transcript has it. */
export interface ConductorEnvelope {
  /** The proposal it would open, if the conductor answers with one. */
  id: string;
  /** The conductor, by id. */
  lead: string;
  /** Which version of the conductor's context this turn assumed. */
  context: string;
  /** What the user wrote. */
  request: string;
  /** Its attached files' `@path` mentions, as on {@link Envelope}. */
  attached: string;
}

/** The conductor envelope `text` is, or null. */
export function readConductorEnvelope(text: string): ConductorEnvelope | null {
  if (!text.startsWith(CONDUCTOR_OPEN)) return null;
  const match = CONDUCTOR_ENVELOPE.exec(text.trim());
  if (!match) return null;
  const body = match[4] ?? "";
  const start = body.lastIndexOf("<user_request>\n");
  const end = body.lastIndexOf("\n</user_request>");
  if (start === -1 || end < start) return null;
  return {
    id: match[1] ?? "",
    lead: match[2] ?? "",
    context: match[3] ?? "",
    request: body.slice(start + "<user_request>\n".length, end),
    attached: match[5] ?? "",
  };
}

// ─── Reading the reply ──────────────────────────────────────────────────────

/** What the lead proposed, checked; or why it could not be read. */
export type ReadProposal =
  | { ok: true; title: string; summary: string; tasks: ProposedTask[] }
  | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Each task's agent and model, checked against the catalog.
 *
 * A model with no agent takes the agent that runs it; an agent with no model
 * runs its tier's default (null model). A pair the app does not offer is
 * refused: main would refuse it at approval anyway, later and less clearly.
 */
function checkModels(
  tasks: ProposedTask[],
  lead: TeamLead | null,
): ProposedTask[] {
  const models = catalog(lead);
  return tasks.map((task) => {
    if (task.model === null) {
      if (lead && !tiersAllowed(lead))
        throw new Error(
          `Task "${task.id}" names no model, but the conductor "${lead.name}" has no tiers. Use one of: ${models.map((entry) => entry.model).join(", ")}`,
        );
      return task;
    }
    if (lead?.workers.length) {
      const worker = models.find(
        (entry) =>
          entry.model === task.model &&
          (task.agent === null || entry.agent === task.agent),
      );
      if (!worker)
        throw new Error(
          `Task "${task.id}" names model "${task.model}", which the conductor "${lead.name}" does not offer. Use one of: ${models.map((entry) => entry.model).join(", ")}`,
        );
      return { ...task, agent: worker.agent };
    }
    const found = allModels().find((entry) => entry.id === task.model);
    // Codex's list moves faster than ours: an unlisted Codex model is kept
    // and the card warns, rather than locking the proposal (FE-91/U9).
    if (!found && task.agent === "codex") return task;
    // So is OpenCode's (FE-105): its list is the user's providers, read from
    // its service, and may not be read yet. A well-formed `provider/model`
    // is kept as OpenCode's, its agent filled in; main has the last word.
    if (
      !found &&
      (task.agent === "opencode" || task.agent === null) &&
      OPENCODE_MODEL_ID.test(task.model)
    )
      return { ...task, agent: "opencode" };
    if (!found)
      throw new Error(
        `Task "${task.id}" names model "${task.model}", which is not in the catalog. Use one of: ${models.map((entry) => entry.model).join(", ")}`,
      );
    if (task.agent !== null && task.agent !== found.agent)
      throw new Error(
        `Task "${task.id}" runs "${task.model}" on ${task.agent}, but that model runs on ${found.agent}`,
      );
    return { ...task, agent: found.agent };
  });
}

/** The JSON the reply holds: the tagged block, else a fenced one, else all. */
function rawProposal(response: string): string {
  const tagged = [...response.matchAll(PROPOSAL_TAG)].at(-1)?.[1];
  if (tagged) return tagged;
  const fenced = [...response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(
    -1,
  )?.[1];
  return (fenced ?? response).trim();
}

/**
 * The lead's reply, as a proposal the card can draw.
 *
 * Under a team lead, every task's model must be one of its workers.
 */
export function readProposal(
  response: string,
  lead: TeamLead | null = null,
): ReadProposal {
  if (!response.trim())
    return { ok: false, error: "The lead answered with no proposal." };
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawProposal(response));
    } catch {
      throw new Error(
        "The reply holds no JSON proposal inside <lanework_proposal>…</lanework_proposal>.",
      );
    }
    const input = record(parsed);
    if (!input) throw new Error("The proposal must be one JSON object.");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const summary =
      typeof input.summary === "string" ? input.summary.trim() : "";
    if (!title || title.length > TITLE_MAX)
      throw new Error(
        `Give the proposal a title of 1-${TITLE_MAX} characters.`,
      );
    if (!summary || summary.length > SUMMARY_MAX)
      throw new Error(
        `Give the proposal a summary of 1-${SUMMARY_MAX} characters.`,
      );
    return {
      ok: true,
      title,
      summary,
      tasks: checkModels(parseProposedTasks(input.tasks), lead),
    };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/** The text of an assistant turn, its text blocks joined. */
export function replyText(turn: Turn): string {
  if (turn.role !== "assistant") return "";
  return turn.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

// ─── Proposals in a transcript ──────────────────────────────────────────────

/** A proposal as the transcript has it: the planning turn and its reply. */
export interface DerivedProposal {
  id: string;
  request: string;
  /**
   * - `planning`: the lead is still answering.
   * - `ready`: its reply holds a proposal that passed every check.
   * - `invalid`: it does not; `error` says why.
   */
  status: "planning" | "ready" | "invalid";
  title: string;
  summary: string;
  /** The lead's tasks, before the user's edits. */
  tasks: ProposedTask[];
  error: string | null;
  /** The lead's last reply, for the one repair prompt. */
  response: string;
  /** A repair was already asked: none is offered again. */
  repaired: boolean;
  /** The team lead it was planned under, by id; null for none. */
  teamLead: string | null;
  /**
   * The last reply turn that holds it, by id (FE-134): its settled run is
   * drawn right after that turn. Null before the lead answered.
   */
  afterTurn: string | null;
}

/** A conductor turn, read as the planning turn it may turn out to be. */
function conductorAsEnvelope(
  text: string,
): (Envelope & { conductor: true }) | null {
  const conductor = readConductorEnvelope(text);
  if (!conductor) return null;
  return {
    id: conductor.id,
    kind: "plan",
    request: conductor.request,
    lead: conductor.lead,
    attached: conductor.attached,
    conductor: true,
  };
}

/**
 * The proposals in `turns`, oldest first.
 *
 * A planning turn opens one; a repair turn with its id replaces its reply.
 * `leads` finds the team lead an envelope names; one it does not hold (the
 * list is still being read, or the lead was removed) checks the reply
 * against the whole catalog, as FE-87 did.
 */
export function deriveProposals(
  turns: Turn[],
  working: boolean,
  leads: readonly TeamLead[] = [],
): DerivedProposal[] {
  const found = new Map<string, DerivedProposal>();
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (turn?.role !== "user") continue;
    const envelope: (Envelope & { conductor?: true }) | null =
      readEnvelope(turn.text) ?? conductorAsEnvelope(turn.text);
    if (!envelope) continue;
    let next = index + 1;
    const replies: Turn[] = [];
    while (next < turns.length && turns[next]?.role === "assistant") {
      replies.push(turns[next] as Turn);
      next++;
    }
    const last = next >= turns.length;
    const open =
      replies.some((reply) => reply.role === "assistant" && reply.open) ||
      (replies.length === 0 && last && working);
    const response = replies.map(replyText).filter(Boolean).join("\n\n");
    // A conductor turn is a proposal only when the conductor made it one:
    // a reply that explains proposals and quotes `<lanework_proposal>` in
    // inline code is an answer, not a broken proposal.
    if (envelope.conductor && !PROPOSAL_MARK.test(response)) continue;
    let entry = found.get(envelope.id);
    if (envelope.kind === "plan") {
      entry = {
        id: envelope.id,
        request: envelope.request,
        status: "planning",
        title: "",
        summary: "",
        tasks: [],
        error: null,
        response: "",
        repaired: false,
        teamLead: envelope.lead,
        afterTurn: null,
      };
      found.set(envelope.id, entry);
    } else if (!entry) continue;
    else entry.repaired = true;
    entry.response = response;
    // A repair's reply holds the proposal now, so the run follows it.
    entry.afterTurn = replies.at(-1)?.id ?? entry.afterTurn;
    if (open) {
      entry.status = "planning";
      entry.error = null;
      continue;
    }
    const named = entry.teamLead;
    const lead = named
      ? (leads.find((candidate) => candidate.id === named) ?? null)
      : null;
    const read = readProposal(response, lead);
    if (read.ok) {
      entry.status = "ready";
      entry.title = read.title;
      entry.summary = read.summary;
      entry.tasks = read.tasks;
      entry.error = null;
    } else {
      entry.status = "invalid";
      entry.error = replies.length
        ? read.error
        : "The lead stopped before it answered.";
    }
  }
  return [...found.values()];
}

/** The planning envelope's tags and the summary's limit, for the prompts. */
export {
  CLOSE as ORCHESTRATE_CLOSE,
  OPEN as ORCHESTRATE_OPEN,
  SUMMARY_MAX as PROPOSAL_SUMMARY_MAX,
};

/**
 * The id of the proposal `turns` end on, when it waits on the user: their
 * last proposal, read with no turn running (the rail's dot, FE-95/D4).
 *
 * @returns null when the last one is still planning, invalid, or there is
 *   none.
 */
export function latestReadyProposal(
  turns: Turn[],
  leads: readonly TeamLead[] = [],
): string | null {
  const last = deriveProposals(turns, false, leads).at(-1);
  return last?.status === "ready" ? last.id : null;
}
