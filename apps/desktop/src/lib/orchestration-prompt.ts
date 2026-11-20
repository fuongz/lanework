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
//
// A conductor's own conversation (FE-95) wraps every message the user sends
// in `<lanework_conductor>`: who it is and when to delegate, the first time
// and again whenever that changes. It answers small things itself; for
// substantial work it replies with a proposal, read here the same way.
//
// A conductor's context files (FE-96) go along as a list of paths, never
// their contents: it reads them itself, so it sees them as they are now. The
// caller drops the ones that are gone (`withLiveContext`) and marks folders
// with a trailing `/`; a changed list changes the fingerprint, so the next
// message carries the rules again.
//
// A conductor's memory of the project (FE-128) goes along with the rules,
// never with the one-line reminder: its notes, the ledger of the sessions
// it started and the runs it led (FE-131). It is not in the fingerprint, or
// every ledger write would send the rules again; the conductor reads it fresh
// with `memory.read`.
//
// OpenCode (FE-105/D5) may be a task's worker, never the lead: its models are
// in the catalog as `provider/model` ids, and one the page has not listed yet
// is kept with a warning, as Codex's is.

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
  type ConductorMemory,
  type ConductorRunEntry,
  SESSIONS_ENV,
} from "#/../shared/conductor-sessions";
import {
  AGENT_LABELS,
  type ConversationAgent,
  EFFORTS,
  type Turn,
} from "#/../shared/conversation";
import {
  LEAD_REF_PATTERN,
  type LeadIcon,
  type TeamLead,
  TITLE_MAX,
  WORKERS_MAX,
  withoutComments,
} from "#/../shared/orchestration";
import {
  ORCHESTRATE_CLOSE as CLOSE,
  CONDUCTOR_CLOSE,
  CONDUCTOR_OPEN,
  catalog,
  type Envelope,
  ORCHESTRATE_OPEN as OPEN,
  PROPOSAL_OPEN,
  PROPOSAL_TAG,
  readConductorEnvelope,
  readEnvelope,
  PROPOSAL_SUMMARY_MAX as SUMMARY_MAX,
  tiersAllowed,
} from "#/../shared/orchestration-proposals";

// NOTE: Reading a proposal back out of a transcript lives in shared/, so
// main answers the rail's dot with the same reading the card uses; the
// page's callers keep importing it from here.
export {
  type CatalogEntry,
  type ConductorEnvelope,
  catalog,
  type DerivedProposal,
  deriveProposals,
  type Envelope,
  type ReadProposal,
  readConductorEnvelope,
  readEnvelope,
  readProposal,
  replyText,
  tiersAllowed,
} from "#/../shared/orchestration-proposals";

/** How many workers run at once unless the user picks another number. */
export const DEFAULT_MAX_WORKERS = 3;
/** The most of the lead's previous reply a repair prompt carries. */
const REPAIR_RESPONSE_MAX = 60_000;

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

/** Whether the catalog under `lead` offers any of `agent`'s models. */
function catalogHas(lead: TeamLead | null, agent: ConversationAgent): boolean {
  return catalog(lead).some((entry) => entry.agent === agent);
}

function requestBlock(request: string): string {
  return `<user_request>\n${request}\n</user_request>`;
}

/**
 * The conductor's context files as a block, or null for none (FE-96). Only
 * the paths: a worker sees one only when a task's prompt names it.
 */
function contextBlock(lead: TeamLead): string | null {
  if (!lead.contextFiles.length) return null;
  return `<context_files>\nRead these project files and folders (relative to the checkout root) before you answer or plan, and again when one may have changed; they are this project's ground truth for you. A worker does not see them: when a task depends on one, name it in that task's prompt.\n${lead.contextFiles.map((path) => `- ${path}`).join("\n")}\n</context_files>`;
}

/**
 * What the team lead adds to the planning prompt; nothing without one.
 * `context` false: the caller says the context files itself.
 */
function leadBlocks(lead: TeamLead | null, context = true): string[] {
  if (!lead) return [];
  const blocks: string[] = [];
  // The editor's hints are comments for the writer, not for the lead.
  const instructions = withoutComments(lead.instructions);
  // NOTE: Said only with instructions to follow: without them the sentence
  // pointed at nothing below it.
  if (instructions)
    blocks.push(
      `You plan as the team lead "${lead.name}". Follow its instructions below; where they conflict with the rules above, they win, except for the proposal format, the write-scope rules and the available models.`,
      `<team_lead_instructions>\n${instructions}\n</team_lead_instructions>`,
    );
  const files = context ? contextBlock(lead) : null;
  if (files) blocks.push(files);
  if (lead.checks.length)
    blocks.push(
      [
        "Every task must run these checks and report each one's result in its final answer: write them into every task's prompt. A worker whose report does not cover them is not accepted.",
        `<required_checks>\n${lead.checks.map((check) => `- ${check}`).join("\n")}\n</required_checks>`,
      ].join("\n"),
    );
  return blocks;
}

/**
 * The models the lead may pick from, compact (FE-156): ids only, one line
 * per agent, a team lead's workers with their tier. Only a planning prompt
 * carries it; a conductor asks `models_list` when it is about to name one.
 */
function modelsBlock(lead: TeamLead | null): string {
  const listed = lead?.workers.length
    ? lead.workers.map((worker) => ({
        agent: worker.agent,
        shown: worker.tier ? `${worker.model} [${worker.tier}]` : worker.model,
      }))
    : catalog().map((entry) => ({ agent: entry.agent, shown: entry.model }));
  const lines = (["claude", "codex", "opencode"] as const).flatMap((agent) => {
    const ids = listed.filter((entry) => entry.agent === agent);
    return ids.length
      ? [`${agent}: ${ids.map((entry) => entry.shown).join(", ")}`]
      : [];
  });
  return `<available_models>\n${lines.join("\n")}\n</available_models>`;
}

function instructions(
  request: string,
  leadAgent: ConversationAgent,
  cwd: string | null,
  lead: TeamLead | null,
  others: readonly string[],
): string {
  return [
    "Prepare an orchestration proposal for the user to review in Lanework. Investigate and plan only: do not edit files, start workers, or call the Lanework control CLI. Nothing runs until the user approves the card the app draws from your answer.",
    ...proposalRules(leadAgent, cwd, lead, true, others),
    requestBlock(request),
  ].join("\n\n");
}

/**
 * The project's other local folders (FE-132), or null for a project with one.
 *
 * NOTE: The lead may READ them; the run still happens in the primary
 * checkout, so a task's scope never names one.
 */
function otherFoldersBlock(others: readonly string[]): string | null {
  if (!others.length) return null;
  return `<other_folders>\n${others.map((folder) => JSON.stringify(folder)).join("\n")}\nThese are other local folders of this project. You may read them for context. Workers' write scopes, worktrees and merges stay in the checkout root; never put another folder's path in a task's files.\n</other_folders>`;
}

/** How a proposal is made and written: the catalog, scopes and schema. */
function proposalRules(
  leadAgent: ConversationAgent,
  cwd: string | null,
  lead: TeamLead | null,
  context = true,
  others: readonly string[] = [],
): string[] {
  const tiers = tiersAllowed(lead);
  const limit = lead ? lead.maxWorkers : DEFAULT_MAX_WORKERS;
  const root = cwd
    ? `The checkout root is ${JSON.stringify(cwd)}. Every files entry must be "." or a path relative to it: a path you found under it goes without the root prefix. Never an absolute path, never "..".`
    : 'Every files entry must be "." or a path relative to the checkout root. Never an absolute path, never "..".';
  return [
    context
      ? `You are the lead (${AGENT_LABELS[leadAgent]}). Decide the task breakdown yourself and pick each worker's agent and model from the catalog below${lead ? ", and only from it" : ""}; the user can change any of it on the card before approving. Do not ask them to assemble a team.`
      : `You are the lead (${AGENT_LABELS[leadAgent]}). Decide the task breakdown yourself and pick each worker's agent and model; the user can change any of it on the card before approving. Do not ask them to assemble a team. Before you name a model, call the models_list tool (or \`"$${SESSIONS_ENV.cli}" models.list\`): it lists the models you may name${lead?.workers.length ? " (this conductor's own workers, and only those)" : ""} and how each fared in your past runs; prefer ones accepted for similar work and avoid ones that failed or got blocked.`,
    `Keep planning cheap: read only what you need to understand the request and the project's conventions. Use the fewest useful tasks, each with a clear deliverable and its own checks. No worker for a trivial step, no two workers investigating the same thing. Put easy, mechanical work on a fast, cheap model and keep the capable ones for work that needs them; do not invent capabilities or prices.${tiers ? " To let the app pick by tier instead, set agent and model to null." : " Name a model for every task: agent and model are never null."}`,
    'Give every task self-contained instructions and project-relative write scopes in files; a directory covers everything under it, and [] means the task edits no file. Run independent work in parallel on disjoint files, and order edits to a shared file with dependsOn. A task that regenerates or validates the whole project gets files ["."]. Workers must never commit, push, switch branches or write outside the checkout; each runs in its own isolated checkout the app makes, so never ask one to create a worktree. Any git finalisation the user asked for is yours, after every worker is reviewed and the run is finished: no worker does it.',
    root,
    "Return the proposal as one JSON object inside <lanework_proposal>...</lanework_proposal>, and nothing after it. The app renders it as an editable card, so do not ask for approval in prose. No Markdown inside the JSON. dependsOn names other task ids; the graph must have no cycle.",
    `Schema: {"title":"Short title","summary":"What will be done and how the tasks fit together","tasks":[{"id":"task-1","title":"Short task title","prompt":"Self-contained instructions, constraints and checks","agent":"claude|codex|opencode|null","model":"exact model id or null","effort":"${EFFORTS.join("|")}|null","files":["src/feature"],"dependsOn":[]}]}`,
    ...(catalogHas(lead, "opencode")
      ? [
          'OpenCode models (agent "opencode", ids "provider/model") run as workers only, never as the lead. Name the exact id.',
        ]
      : []),
    `Task ids: 1-64 letters, digits, - or _. Titles: at most ${TITLE_MAX} characters. Summary: at most ${SUMMARY_MAX}. Parallel worker limit: ${limit} (at most ${lead ? lead.maxWorkers : WORKERS_MAX}).`,
    // NOTE: Wrapped in an array: spreading the string itself would add it
    // one character at a time.
    ...[otherFoldersBlock(others)].filter(
      (block): block is string => block !== null,
    ),
    ...(context ? [modelsBlock(lead)] : []),
    ...leadBlocks(lead, context),
  ];
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
  others: readonly string[] = [],
): string {
  return wrap(
    id,
    "plan",
    lead,
    instructions(request, leadAgent, cwd, lead, others),
  );
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
  others: readonly string[] = [],
): string {
  return wrap(
    id,
    "repair",
    lead,
    [
      instructions(request, leadAgent, cwd, lead, others),
      "Your previous proposal was refused. Fix it using the error below. Reuse your investigation and task breakdown: do not read the project again or run tools, and do not start any task. Return only the corrected <lanework_proposal> JSON.",
      `Validation error: ${error}`,
      `<previous_response>\n${response.slice(-REPAIR_RESPONSE_MAX)}\n</previous_response>`,
    ].join("\n\n"),
  );
}

// ─── A conductor's own conversation (FE-95) ─────────────────────────────────

/** Bumped when the rules below change, so a live conversation gets them again. */
const CONDUCTOR_PROMPT_VERSION = 5;

/** A short, stable fingerprint: FNV-1a, base 36. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * What the conductor is told about itself: changes when the conductor, the
 * checkout or the rules do, so the next message carries it again.
 */
export function conductorContext(
  lead: TeamLead,
  cwd: string | null,
  others: readonly string[] = [],
): string {
  return fingerprint(
    JSON.stringify([
      CONDUCTOR_PROMPT_VERSION,
      { ...lead, source: undefined },
      cwd,
      catalog(lead),
      // A folder linked or unlinked since is news to the conductor (FE-132).
      others,
    ]),
  );
}

/** One line of a memory's ledger: what the session was and where it stands. */
function ledgerLine(entry: ConductorMemory["ledger"][number]): string {
  const facts = [
    `agent: ${entry.agent}`,
    `status: ${entry.status}`,
    ...(entry.taskId ? [`task: ${entry.taskId}`] : []),
    `sessionId: ${entry.sessionId}`,
  ].join(", ");
  const summary = entry.summary.replace(/\s+/g, " ").trim();
  return `- ${entry.title} (${facts})${summary ? `: ${summary}` : ""}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One line of a memory's runs: the run, then each task and how it ended. */
function runLine(entry: ConductorRunEntry): string {
  const ended = new Date(entry.endedAt).toISOString().slice(0, 10);
  const tasks = entry.tasks
    .map(
      (task) =>
        `${task.agent}/${oneLine(task.model)}${task.tier ? `[${task.tier}]` : ""} -> ${task.outcome}`,
    )
    .join("; ");
  return `- ${oneLine(entry.title)} (${entry.status}, ended ${ended})${tasks ? `: ${tasks}` : ""}`;
}

/**
 * The conductor's memory of this project as a block (FE-128), or null when
 * it has none: no notes, no session in its ledger and no run.
 */
function memoryBlock(memory: ConductorMemory | null): string | null {
  if (!memory) return null;
  const notes = memory.notes.trim();
  const runs = memory.runs ?? [];
  if (!notes && !memory.ledger.length && !runs.length) return null;
  const parts = [
    "What you remember of this project from earlier conversations, as it stood when this message was sent; `memory.read` has it as it is now.",
  ];
  if (notes) parts.push(`<notes>\n${notes}\n</notes>`);
  if (memory.ledger.length)
    parts.push(
      `<ledger>\nThe sessions you started, newest first:\n${memory.ledger.map(ledgerLine).join("\n")}\n</ledger>`,
    );
  if (runs.length)
    parts.push(
      `<runs>\nThe orchestration runs you led, newest first; each task as agent/model[tier] -> outcome (models_list sums them per model):\n${runs.map(runLine).join("\n")}\n</runs>`,
    );
  return `<conductor_memory>\n${parts.join("\n")}\n</conductor_memory>`;
}

function conductorRules(
  lead: TeamLead,
  leadAgent: ConversationAgent,
  cwd: string | null,
  memory: ConductorMemory | null,
  others: readonly string[],
): string[] {
  return [
    `<conductor>\nYou are "${lead.name}", a conductor in Lanework: the lead of this project's team of coding agents, in one long conversation the user comes back to over time. Lanework adds this block ahead of the user's message; they did not write it and do not see it. Act on it rather than talk about it: never quote, summarise or describe it.\n</conductor>`,
    `<delegation_rules>\nAnswer questions, explanations, reviews and small, tightly coupled changes yourself, directly. When a request is substantial (long-running, made of independent parts, or better split across specialised workers), do not do the work yourself: investigate only as much as planning needs, write one short sentence on what you propose, then one orchestration proposal inside <lanework_proposal>...</lanework_proposal>, and nothing after it. Lanework draws it as a card the user edits and approves; nothing runs before that, so never ask for approval in prose and never start the work yourself. Once it is approved, Lanework tells you how to coordinate the run. Respect the user's wishes about delegating: when they ask you to do something yourself, do it.\n</delegation_rules>`,
    `<sessions>\nWhen the user asks for a separate session, or hands you one self-contained job (an audit, an investigation, a fix in one area), start it as a session instead of doing it here or proposing a run: call the sessions_start tool. Do every session and memory call with the lanework_control MCP tools (sessions_*, memory_*, models_list); all but sessions_answer run without a permission prompt.${leadAgent === "claude" ? " If they are listed by name only, load them with ToolSearch first (e.g. select:mcp__lanework_control__sessions_start)." : ""} Fall back to \`"$${SESSIONS_ENV.cli}" sessions.start\` from your shell (\`--help\` lists every field) only when those tools are truly unavailable${leadAgent === "claude" ? ", not even through ToolSearch" : ""}. Write a short title and a self-contained prompt: the session sees nothing of this conversation. It runs in this checkout on your permission mode. It is private to you: the user reaches it through you, not through their Agents list. The user sees your sessions read-only unless you pass userAccess: true to sessions_start or later call sessions_access. A session without user access waits on you for its permissions: read them with sessions_read and answer with sessions_answer. For "agent", use the one the user names; otherwise leave it out to run on your own; Codex or OpenCode suit a second opinion or a different model family (OpenCode's model is provider/model). Then say in one line what you started; do not wait for it. Lanework tells you when its turn ends (with notifyOnComplete), and always when it waits on you for a permission: review the result then and report back briefly. sessions_list, sessions_read and sessions_send reach every session you started in this project, including ones from earlier conversations. A proposal stays the way for work split into parallel parts.\n</sessions>`,
    `<memory_rules>\nYour memory of this project persists across your conversations: Lanework keeps a ledger of the sessions you started, and you keep notes. Use the lanework_control tools: memory_read when you need that history; memory_append to add one decision, convention, open thread or next step; memory_write only to rewrite the notes whole (it replaces them, so send everything worth keeping, and keep them short). Only when those tools are truly unavailable does the CLI do the same: \`"$${SESSIONS_ENV.cli}" memory.read|memory.append|memory.write\`, with the JSON passed through \`--input -\` and a quoted heredoc rather than inline \`--json\`.\n</memory_rules>`,
    // Its context files stand for every answer, not only for a proposal.
    contextBlock(lead),
    `<proposal_rules>\n${proposalRules(leadAgent, cwd, lead, false, others).join("\n\n")}\n</proposal_rules>`,
    memoryBlock(memory),
  ].filter((block): block is string => block !== null);
}

/**
 * A message to a conductor, wrapped.
 *
 * The rules go along when `previous` (the context the conversation last
 * carried) is not this one: the first message, and after the conductor, the
 * checkout or the rules changed. Otherwise a one-line reminder.
 *
 * `memory` (FE-128) goes along with the rules only, never with the reminder;
 * null, or an empty memory, sends no block.
 */
export function conductorTurn(
  request: string,
  lead: TeamLead,
  leadAgent: ConversationAgent,
  cwd: string | null,
  previous: string | null,
  memory: ConductorMemory | null = null,
  others: readonly string[] = [],
): string {
  const context = conductorContext(lead, cwd, others);
  const blocks =
    previous === context
      ? [
          `<conductor>\nYou are still "${lead.name}", the conductor; the rules from earlier in this conversation stand.\n</conductor>`,
        ]
      : conductorRules(lead, leadAgent, cwd, memory, others);
  return `${CONDUCTOR_OPEN} id="${proposalId()}" lead="${lead.id}" context="${context}">\n${[
    ...blocks,
    requestBlock(request),
  ].join("\n\n")}\n${CONDUCTOR_CLOSE}`;
}

/**
 * The context the conversation's last conductor turn carried, or null.
 *
 * @param before What main says of the turns before `turns`, when the chat
 *   holds only its newest (`Conversation.summary.conductorContext`): the
 *   answer when none of `turns` is a conductor turn.
 *
 * NOTE: Without it, a conductor whose last turn fell out of the window would
 * be sent its whole rules again, as if its context had changed.
 */
export function lastConductorContext(
  turns: readonly Turn[],
  before: string | null = null,
): string | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn?.role !== "user") continue;
    const envelope = readConductorEnvelope(turn.text);
    if (envelope) return envelope.context;
  }
  return before;
}

/**
 * `text` as the chat shows it: a planning prompt as the user's request, and
 * a reply's proposal JSON taken out, since the card below draws it.
 */
/**
 * What main adds around a turn and the chat never shows: a worker's rules
 * (`<lanework_assignment>`), main's notes to the lead
 * (`<lanework_orchestration>`) and to a conductor about its sessions
 * (`<lanework_sessions>`). Mirrors `HIDDEN_BLOCKS` in
 * `electron/main/orchestration/prompts.ts`.
 */
const RUNTIME_BLOCKS =
  /(?:\r?\n[ \t]*)*<(lanework_assignment|lanework_orchestration|lanework_sessions)\b[^>]*>[\s\S]*?<\/\1>/g;

/**
 * What the user wrote, then the `@path` mentions of the files they attached,
 * as main writes them after an envelope: the chat draws each as a file badge,
 * as it does in a message with no envelope.
 */
function withAttached(request: string, attached: string): string {
  return [request.trim(), attached.trim()].filter(Boolean).join("\n\n");
}

export function visibleText(raw: string): string {
  const text = raw.includes("<lanework_")
    ? raw.replace(RUNTIME_BLOCKS, "").trim()
    : raw;
  const envelope = readEnvelope(text);
  if (envelope)
    return envelope.kind === "plan"
      ? withAttached(
          `/orchestrate ${envelope.lead ? `@${envelope.lead} ` : ""}${envelope.request}`,
          envelope.attached,
        )
      : "Asked the lead to fix its proposal.";
  const conductor = readConductorEnvelope(text);
  if (conductor) return withAttached(conductor.request, conductor.attached);
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
    if (turn.role === "compaction" || turn.role === "handoff") return [turn];
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
