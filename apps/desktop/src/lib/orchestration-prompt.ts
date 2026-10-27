// `/orchestrate` as text (FE-87): the planning prompt the lead is sent, the
// envelope that marks it in the transcript, and the lead's proposal read back
// out of its reply.
//
// NOTE: The proposal is never kept anywhere but the transcript. The card is
// derived from the planning turn and the reply after it, so a reload, a
// second window or a restart all draw the same card, and a half-written reply
// never becomes a run (it stays `planning` until the turn closes).
//
// A team lead (FE-88) is named in the envelope by id, so a reload knows
// which preset planned it; an envelope without one is FE-87's, unchanged.

import {
  AiChipIcon,
  Brain02Icon,
  FlashIcon,
  Flowchart01Icon,
  Idea01Icon,
  Layers01Icon,
  MagicWand01Icon,
  Robot02Icon,
  Shield01Icon,
  SparklesIcon,
  Target02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import {
  AGENT_LABELS,
  allModels,
  type ConversationAgent,
  EFFORTS,
  modelName,
  type Turn,
} from "#/../shared/conversation";
import {
  LEAD_REF_PATTERN,
  type LeadIcon,
  type ProposedTask,
  parseProposedTasks,
  type TeamLead,
  TITLE_MAX,
  WORKERS_MAX,
} from "#/../shared/orchestration";

/** How many workers run at once unless the user picks another number. */
export const DEFAULT_MAX_WORKERS = 3;
/** The most of the lead's previous reply a repair prompt carries. */
const REPAIR_RESPONSE_MAX = 60_000;
const SUMMARY_MAX = 2000;

const OPEN = "<lanework_orchestrate";
const CLOSE = "</lanework_orchestrate>";
const ENVELOPE =
  /^<lanework_orchestrate id="([A-Za-z0-9_-]{1,64})" kind="(plan|repair)"(?: lead="((?:repo:)?[a-z0-9][a-z0-9-]{0,47})")?>\n([\s\S]*)\n<\/lanework_orchestrate>$/;
const PROPOSAL_TAG =
  /<lanework_proposal>\s*([\s\S]*?)\s*<\/lanework_proposal>/g;
/** A proposal block still being streamed: from its tag to the end. */
const PROPOSAL_OPEN = /<lanework_proposal>[\s\S]*$/;

/** What the user sent, as the transcript has it. */
export interface Envelope {
  /** The proposal it plans or repairs. */
  id: string;
  kind: "plan" | "repair";
  /** What the user asked for. */
  request: string;
  /** The team lead it was planned under, by id; null for none (FE-87). */
  lead: string | null;
}

/** Each {@link LeadIcon}'s drawing, for the composer and the card. */
const LEAD_ICON_DATA = {
  Robot02Icon,
  Brain02Icon,
  Flowchart01Icon,
  Target02Icon,
  Shield01Icon,
  MagicWand01Icon,
  SparklesIcon,
  Wrench01Icon,
  Layers01Icon,
  Idea01Icon,
  FlashIcon,
  AiChipIcon,
} satisfies Record<LeadIcon, unknown>;

/** A team lead's icon, as `HugeiconsIcon` draws it. */
export function leadIcon(icon: LeadIcon | null | undefined) {
  return (icon && LEAD_ICON_DATA[icon]) || Robot02Icon;
}

/** Where a team lead comes from, as the composer and the card say it. */
export const LEAD_SOURCE_LABELS: Record<TeamLead["source"], string> = {
  builtin: "Built in",
  personal: "Yours",
  repo: "This repo",
};

/**
 * `/orchestrate [@lead] <request>`, split.
 *
 * `lead` is the first token's id when it is `@` and a slug (`repo:<slug>`
 * for a project's own); the request is what follows. A first token that is `@` and no slug (`@src/app.tsx`) is
 * the request's, not a lead.
 */
export function splitLead(request: string): {
  lead: string | null;
  request: string;
} {
  const match = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(request.trim());
  if (!match || !LEAD_REF_PATTERN.test(match[1] ?? ""))
    return { lead: null, request: request.trim() };
  return { lead: match[1] ?? null, request: (match[2] ?? "").trim() };
}

/** A new proposal's id: what `ID_PATTERN` allows. */
export function proposalId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `p${Date.now().toString(36)}${random}`;
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
  if (lead)
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

function requestBlock(request: string): string {
  return `<user_request>\n${request}\n</user_request>`;
}

/** Whether a task may leave its model to the tier under `lead`. */
export function tiersAllowed(lead: TeamLead | null): boolean {
  return !lead || lead.workers.some((worker) => worker.tier !== null);
}

/** What the team lead adds to the planning prompt; nothing without one. */
function leadBlocks(lead: TeamLead | null): string[] {
  if (!lead) return [];
  const blocks = [
    `You plan as the team lead "${lead.name}". Follow its instructions below; where they conflict with the rules above, they win, except for the proposal format, the write-scope rules and the available models.`,
  ];
  if (lead.instructions)
    blocks.push(
      `<team_lead_instructions>\n${lead.instructions}\n</team_lead_instructions>`,
    );
  if (lead.checks.length)
    blocks.push(
      [
        "Every task must run these checks and report each one's result in its final answer: write them into every task's prompt. A worker whose report does not cover them is not accepted.",
        `<required_checks>\n${lead.checks.map((check) => `- ${check}`).join("\n")}\n</required_checks>`,
      ].join("\n"),
    );
  return blocks;
}

/** The models the lead may pick from; a team lead's carry their tier. */
function modelsBlock(lead: TeamLead | null): string {
  const listed = lead
    ? lead.workers.map((worker) => ({
        agent: worker.agent,
        model: worker.model,
        label: modelName(worker.model) ?? worker.model,
        tier: worker.tier,
      }))
    : catalog();
  return `<available_models>\n${JSON.stringify(listed)}\n</available_models>`;
}

function instructions(
  request: string,
  leadAgent: ConversationAgent,
  cwd: string | null,
  lead: TeamLead | null,
): string {
  const tiers = tiersAllowed(lead);
  const limit = lead ? lead.maxWorkers : DEFAULT_MAX_WORKERS;
  const root = cwd
    ? `The checkout root is ${JSON.stringify(cwd)}. Every files entry must be "." or a path relative to it: a path you found under it goes without the root prefix. Never an absolute path, never "..".`
    : 'Every files entry must be "." or a path relative to the checkout root. Never an absolute path, never "..".';
  return [
    "Prepare an orchestration proposal for the user to review in Lanework. Investigate and plan only: do not edit files, start workers, or call the Lanework control CLI. Nothing runs until the user approves the card the app draws from your answer.",
    `You are the lead (${AGENT_LABELS[leadAgent]}). Decide the task breakdown yourself and pick each worker's agent and model from the catalog below${lead ? ", and only from it" : ""}; the user can change any of it on the card before approving. Do not ask them to assemble a team.`,
    `Keep planning cheap: read only what you need to understand the request and the project's conventions. Use the fewest useful tasks, each with a clear deliverable and its own checks. No worker for a trivial step, no two workers investigating the same thing. Put easy, mechanical work on a fast, cheap model and keep the capable ones for work that needs them; do not invent capabilities or prices.${tiers ? " To let the app pick by tier instead, set agent and model to null." : " Name a model for every task: agent and model are never null."}`,
    'Give every task self-contained instructions and project-relative write scopes in files; a directory covers everything under it, and [] means the task edits no file. Run independent work in parallel on disjoint files, and order edits to a shared file with dependsOn. A task that regenerates or validates the whole project gets files ["."]. Workers must never commit, push, switch branches or write outside the checkout; each runs in its own isolated checkout the app makes, so never ask one to create a worktree. Any git finalisation the user asked for is yours, after every worker is reviewed and the run is finished: no worker does it.',
    root,
    "Return the proposal as one JSON object inside <lanework_proposal>...</lanework_proposal>, and nothing after it. The app renders it as an editable card, so do not ask for approval in prose. No Markdown inside the JSON. dependsOn names other task ids; the graph must have no cycle.",
    `Schema: {"title":"Short title","summary":"What will be done and how the tasks fit together","tasks":[{"id":"task-1","title":"Short task title","prompt":"Self-contained instructions, constraints and checks","agent":"claude|codex|null","model":"exact model id or null","effort":"${EFFORTS.join("|")}|null","files":["src/feature"],"dependsOn":[]}]}`,
    `Task ids: 1-64 letters, digits, - or _. Titles: at most ${TITLE_MAX} characters. Summary: at most ${SUMMARY_MAX}. Parallel worker limit: ${limit} (at most ${lead ? lead.maxWorkers : WORKERS_MAX}).`,
    modelsBlock(lead),
    ...leadBlocks(lead),
    requestBlock(request),
  ].join("\n\n");
}

function wrap(
  id: string,
  kind: Envelope["kind"],
  lead: TeamLead | null,
  body: string,
): string {
  const named = lead ? ` lead="${lead.id}"` : "";
  return `${OPEN} id="${id}" kind="${kind}"${named}>\n${body}\n${CLOSE}`;
}

/**
 * The first turn: investigate and plan, answer with one proposal.
 *
 * Without a team lead it is FE-87's prompt, word for word.
 */
export function planningPrompt(
  id: string,
  request: string,
  leadAgent: ConversationAgent,
  cwd: string | null,
  lead: TeamLead | null = null,
): string {
  return wrap(id, "plan", lead, instructions(request, leadAgent, cwd, lead));
}

/**
 * The one corrective turn: the same instructions, the error, the reply.
 *
 * The lead keeps its investigation; it is asked only to fix the JSON.
 */
export function repairPrompt(
  id: string,
  request: string,
  leadAgent: ConversationAgent,
  cwd: string | null,
  error: string,
  response: string,
  lead: TeamLead | null = null,
): string {
  return wrap(
    id,
    "repair",
    lead,
    [
      instructions(request, leadAgent, cwd, lead),
      "Your previous proposal was refused. Fix it using the error below. Reuse your investigation and task breakdown: do not read the project again or run tools, and do not start any task. Return only the corrected <lanework_proposal> JSON.",
      `Validation error: ${error}`,
      `<previous_response>\n${response.slice(-REPAIR_RESPONSE_MAX)}\n</previous_response>`,
    ].join("\n\n"),
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
  };
}

/**
 * `text` as the chat shows it: a planning prompt as the user's request, and
 * a reply's proposal JSON taken out, since the card below draws it.
 */
/**
 * What main adds around a turn and the chat never shows: a worker's rules
 * (`<lanework_assignment>`) and main's notes to the lead
 * (`<lanework_orchestration>`). Mirrors `HIDDEN_BLOCKS` in
 * `electron/main/orchestration/prompts.ts`.
 */
const RUNTIME_BLOCKS =
  /(?:\r?\n[ \t]*)*<(lanework_assignment|lanework_orchestration)\b[^>]*>[\s\S]*?<\/\1>/g;

export function visibleText(raw: string): string {
  const text = raw.includes("<lanework_")
    ? raw.replace(RUNTIME_BLOCKS, "").trim()
    : raw;
  const envelope = readEnvelope(text);
  if (envelope)
    return envelope.kind === "plan"
      ? `/orchestrate ${envelope.lead ? `@${envelope.lead} ` : ""}${envelope.request}`
      : "Asked the lead to fix its proposal.";
  if (!text.includes("<lanework_proposal>")) return text;
  return text.replace(PROPOSAL_TAG, "").replace(PROPOSAL_OPEN, "").trimEnd();
}

/** `turns` as the chat shows them (see {@link visibleText}). */
export function visibleTurns(turns: Turn[]): Turn[] {
  let changed = false;
  const next = turns.flatMap((turn): Turn[] => {
    if (turn.role === "user") {
      const text = visibleText(turn.text);
      if (text === turn.text) return [turn];
      changed = true;
      // A turn that was only main's note to the lead shows as no message.
      if (!text && !turn.attachments.length) return [];
      return [{ ...turn, text }];
    }
    if (
      !turn.blocks.some(
        (block) =>
          block.type === "text" && block.text.includes("<lanework_proposal>"),
      )
    )
      return [turn];
    changed = true;
    return [
      {
        ...turn,
        blocks: turn.blocks.map((block) =>
          block.type === "text"
            ? { ...block, text: visibleText(block.text) }
            : block,
        ),
      },
    ];
  });
  return changed ? next : turns;
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
          `Task "${task.id}" names no model, but the team lead "${lead.name}" has no tiers. Use one of: ${models.map((entry) => entry.model).join(", ")}`,
        );
      return task;
    }
    if (lead) {
      const worker = models.find(
        (entry) =>
          entry.model === task.model &&
          (task.agent === null || entry.agent === task.agent),
      );
      if (!worker)
        throw new Error(
          `Task "${task.id}" names model "${task.model}", which the team lead "${lead.name}" does not offer. Use one of: ${models.map((entry) => entry.model).join(", ")}`,
        );
      return { ...task, agent: worker.agent };
    }
    const found = allModels().find((entry) => entry.id === task.model);
    // Codex's list moves faster than ours: an unlisted Codex model is kept
    // and the card warns, rather than locking the proposal (FE-91/U9).
    if (!found && task.agent === "codex") return task;
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
    const envelope = readEnvelope(turn.text);
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
      };
      found.set(envelope.id, entry);
    } else if (!entry) continue;
    else entry.repaired = true;
    entry.response = response;
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
