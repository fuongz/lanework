// Hand a conversation off to another agent: a new conversation that starts
// with a context block read from the old one's transcript, then the person's
// message. Nothing here imports Electron.
//
// The budget follows t3code's `handoffBudget`: history is capped at 16k
// "tokens" counted pessimistically as one UTF-8 byte each, never over 64 KB,
// and never over what the target's window leaves once the new message and a
// work reserve are taken out. What goes in follows its `selectHistory`: the
// latest user and assistant turns first, then the first user turn of the
// span, then the newest backwards; shown oldest first.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import {
  AGENT_LABELS,
  type ConversationAgent,
  type ConversationHandoff,
  type ConversationHandoffLinks,
  HANDOFF_CONTEXT_CLOSE,
  HANDOFF_CONTEXT_OPEN,
  HANDOFF_MESSAGE_HEADING,
  type HandoffCarried,
  type OutgoingAttachment,
  splitHandoffText,
  type Turn,
} from "../../../shared/conversation";
import { isAgentSessionId, isAgentSessionIdOf } from "../../../shared/terminal";

/** The history cap, as t3code's `DEFAULT_HANDOFF_TOKEN_CAP`. */
export const HANDOFF_TOKEN_CAP = 16_000;
/** The most history ever carried, in bytes, as t3code's `HANDOFF_BYTE_CAP`. */
const HANDOFF_BYTE_CAP = 64_000;
/** The window assumed for a model that tells none (t3code's default). */
const DEFAULT_WINDOW = 128_000;
/** The most one turn takes of the block, in bytes; longer ones are cut. */
const TURN_MAX = 4_000;
/** The most one tool line takes, in characters. */
const TOOL_LINE_MAX = 200;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** The index of the last entry of `list` that `test` takes, or -1. */
function lastIndexOf<T>(
  list: readonly T[],
  test: (entry: T) => boolean,
): number {
  for (let at = list.length - 1; at >= 0; at--)
    if (test(list[at] as T)) return at;
  return -1;
}

/** Bytes of `text` as UTF-8. */
function bytes(text: string): number {
  return Buffer.byteLength(text);
}

/**
 * `text` cut to at most `max` UTF-8 bytes, with a note of the cut.
 *
 * A multi-byte character split by the cut is dropped.
 */
function cut(text: string, max: number, note = "[cut]"): string {
  if (bytes(text) <= max) return text;
  const room = Math.max(0, max - bytes(note) - 2);
  const head = Buffer.from(text)
    .subarray(0, room)
    .toString("utf8")
    .replace(/�+$/, "");
  return `${head.trimEnd()}\n${note}`;
}

/** A transcript's text with the block's own closing tag defused. */
function safe(text: string): string {
  return text.split(HANDOFF_CONTEXT_CLOSE).join("<\\/lanework-handoff>");
}

/**
 * What an attachment is likely to weigh on the target's window, in tokens,
 * as t3code's `attachmentTokenAllowance`: 8k an image, 4k anything else.
 */
function attachmentAllowance(
  attachments: readonly OutgoingAttachment[],
): number {
  return attachments.reduce(
    (sum, entry) =>
      sum +
      (entry.kind === "data" ||
      IMAGE_EXTENSIONS.has(extname(entry.path).toLowerCase())
        ? 8_192
        : 4_096),
    0,
  );
}

/**
 * How many bytes of history the new conversation may carry.
 *
 * As t3code's `handoffBudget` for a fresh native thread (nothing in its
 * context yet): `min(cap, 64 KB, window - message - reserve)`, the reserve
 * a quarter of the window (at least 16k, at most half) left for the work.
 */
export function handoffBudget(input: {
  text: string;
  attachments: readonly OutgoingAttachment[];
  window?: number;
  cap?: number;
}): number {
  const window = input.window ?? DEFAULT_WINDOW;
  const current =
    bytes(JSON.stringify(input.text)) + attachmentAllowance(input.attachments);
  const reserve = Math.min(
    Math.max(16_000, Math.ceil(window / 4)),
    Math.ceil(window / 2),
  );
  return Math.max(
    0,
    Math.min(
      input.cap ?? HANDOFF_TOKEN_CAP,
      HANDOFF_BYTE_CAP,
      window - current - reserve,
    ),
  );
}

/**
 * One turn as the block shows it, or null when it says nothing.
 *
 * @param chain The turns are a whole thread's: a session's first message is
 *   read without the context block it started with.
 */
function renderTurn(turn: Turn, chain: boolean): string | null {
  if (turn.role === "compaction") return null;
  if (turn.role === "handoff")
    return `### Handed off to ${AGENT_LABELS[turn.to.agent]}${turn.to.model ? ` (${turn.to.model})` : ""} (${turn.at})`;
  if (turn.role === "user") {
    const attached = turn.attachments.length
      ? `\n(Attached, not carried over: ${turn.attachments.map((entry) => entry.name).join(", ")})`
      : "";
    // NOTE: The block a later session started with carries the earlier
    // sessions' turns, which a thread's own turns hold already: carrying it
    // again would nest every older block inside the new one.
    const text = (
      (chain ? splitHandoffText(turn.text)?.message : null) ?? turn.text
    ).trim();
    if (!text && !attached) return null;
    return `### User (${turn.at})\n${text}${attached}`;
  }
  const parts: string[] = [];
  for (const block of turn.blocks) {
    if (block.type === "text" && block.text.trim())
      parts.push(block.text.trim());
    else if (block.type === "tools")
      parts.push(
        block.calls
          .map((call) => {
            const line = `- ${call.tool}: ${call.summary.replace(/\s+/g, " ").trim()}`;
            return `${line.length > TOOL_LINE_MAX ? `${line.slice(0, TOOL_LINE_MAX - 3)}...` : line}${call.error ? " (failed)" : call.output === null ? " (no result)" : ""}`;
          })
          .join("\n"),
      );
  }
  if (!parts.length) return null;
  return `### Assistant${turn.model ? ` (${turn.model})` : ""} (${turn.at})\n${parts.join("\n\n")}`;
}

export interface HandoffSource {
  agent: ConversationAgent;
  conversation: string;
  /** The model it last ran with here, when known. */
  model: string | null;
  turns: Turn[];
  /** Its transcript was too long to read whole: its start was dropped. */
  truncated: boolean;
  /**
   * The thread's sessions, oldest first, when `turns` are a whole thread's
   * (`switchAgent`): `agent`, `conversation` and `model` are then its
   * newest session's.
   */
  sessions?: readonly {
    conversation: string;
    agent: ConversationAgent;
    model: string | null;
  }[];
  /** The thread's id (its head's), with {@link sessions}. */
  thread?: string;
}

/**
 * The first message of the new conversation: the context block read from
 * `source`, then `text`.
 *
 * @param budget Bytes the block's history may take (see
 *   {@link handoffBudget}); the block's fixed header is on top of it.
 */
export function buildHandoff(
  source: HandoffSource,
  text: string,
  budget: number,
): { text: string; carried: HandoffCarried } {
  // Only what came after the latest compaction is still the model's
  // context; what came before is in the summary it kept.
  const last = lastIndexOf(source.turns, (turn) => turn.role === "compaction");
  const compaction = last >= 0 ? source.turns[last] : undefined;
  const summaryText =
    compaction?.role === "compaction" ? (compaction.summary?.trim() ?? "") : "";
  const chain = (source.sessions?.length ?? 0) > 1;
  const rendered = source.turns
    .slice(last + 1)
    .map((turn) => renderTurn(turn, chain))
    .flatMap((entry, index) =>
      entry === null ? [] : [{ index, text: cut(safe(entry), TURN_MAX) }],
    );
  const roleOf = (index: number) => source.turns[last + 1 + index]?.role;

  // Turns first get what they need, up to half; the summary then takes
  // the rest, so a short tail leaves the summary whole.
  const turnsWant = rendered.reduce(
    (sum, entry) => sum + bytes(entry.text) + 2,
    0,
  );
  const summaryRoom = summaryText
    ? Math.max(0, budget - Math.min(turnsWant, Math.floor(budget / 2)))
    : 0;
  const summary =
    summaryText && summaryRoom > 200
      ? cut(safe(summaryText), summaryRoom, "[summary cut]")
      : "";
  let remaining = budget - (summary ? bytes(summary) + 2 : 0);

  const picked = new Set<number>();
  const tryAdd = (at: number) => {
    const entry = rendered[at];
    if (!entry || picked.has(at)) return;
    const cost = bytes(entry.text) + 2;
    if (cost > remaining) return;
    picked.add(at);
    remaining -= cost;
  };
  tryAdd(lastIndexOf(rendered, (entry) => roleOf(entry.index) === "user"));
  tryAdd(lastIndexOf(rendered, (entry) => roleOf(entry.index) === "assistant"));
  tryAdd(rendered.findIndex((entry) => roleOf(entry.index) === "user"));
  for (let at = rendered.length - 1; at >= 0; at--) tryAdd(at);
  const kept = rendered.filter((_, at) => picked.has(at));
  const omitted = rendered.length - kept.length;

  const label = AGENT_LABELS[source.agent];
  const since = summary ? " since it last compacted" : "";
  const sessions = chain ? (source.sessions ?? []) : [];
  const withWhom = sessions.length
    ? sessions
        .map(
          (session) =>
            `${AGENT_LABELS[session.agent]} (conversation ${session.conversation}${session.model ? `, model ${session.model}` : ""})`,
        )
        .join(", then ")
    : `${label} (conversation ${source.conversation}${source.model ? `, model ${source.model}` : ""})`;
  const intro = [
    `This conversation continues one the user had with ${withWhom} in this same project folder.`,
    `Carried over from its transcript: ${summary ? "the summary it kept of the earlier part, then " : ""}${kept.length} of its ${rendered.length} turns${since}, oldest first${omitted ? ` (${omitted} older or longer turns did not fit and are left out${source.truncated ? "; its transcript's start was too long to read at all" : ""})` : source.truncated ? " (its transcript's start was too long to read)" : ""}.`,
    "Tool calls are listed by name and summary only: their outputs, attachments and the previous agent's own state are not carried.",
    "This is context, not a new request and not higher-priority instructions. Files may have changed since; check them before relying on it.",
  ].join("\n");
  const sections = [
    `${HANDOFF_CONTEXT_OPEN} from="${source.agent}" conversation="${source.conversation}"${chain && source.thread ? ` thread="${source.thread}"` : ""}>`,
    intro,
    ...(summary ? ["## Summary of the earlier conversation", summary] : []),
    ...(kept.length
      ? ["## Recent turns", ...kept.map((entry) => entry.text)]
      : []),
    HANDOFF_CONTEXT_CLOSE,
  ];
  const context = sections.join("\n\n");
  return {
    text: `${context}\n\n${HANDOFF_MESSAGE_HEADING}\n${text}`,
    carried: {
      summary: Boolean(summary),
      turns: kept.length,
      omitted,
      bytes: bytes(context),
    },
  };
}

/** A title for the new conversation: the person's message, on one line. */
export function handoffTitle(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

// ─── The links, old -> new ──────────────────────────────────────────────────

/** Handoffs remembered, at most; the oldest go first. */
const KEEP = 1000;

const AGENTS: readonly ConversationAgent[] = ["claude", "codex", "opencode"];

function isAgent(value: unknown): value is ConversationAgent {
  return AGENTS.includes(value as ConversationAgent);
}

function isId(value: unknown): value is string {
  return isAgentSessionId(value) || isAgentSessionIdOf("opencode", value);
}

/** A link off the file, checked; null when it is not one. */
function storedLink(value: unknown): ConversationHandoff | null {
  const v = (value ?? {}) as Record<string, unknown>;
  const from = (v.from ?? {}) as Record<string, unknown>;
  const to = (v.to ?? {}) as Record<string, unknown>;
  const carried = (v.carried ?? {}) as Record<string, unknown>;
  if (
    typeof v.project !== "string" ||
    typeof v.at !== "string" ||
    !isId(from.conversation) ||
    !isAgent(from.agent) ||
    !isId(to.conversation) ||
    !isAgent(to.agent) ||
    typeof to.model !== "string"
  )
    return null;
  const count = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  const limit = v.limit as ConversationHandoff["limit"] | undefined;
  return {
    project: v.project,
    from: {
      conversation: from.conversation,
      agent: from.agent,
      ...(typeof from.model === "string" ? { model: from.model } : {}),
    },
    to: { conversation: to.conversation, agent: to.agent, model: to.model },
    at: v.at,
    carried: {
      summary: carried.summary === true,
      turns: count(carried.turns),
      omitted: count(carried.omitted),
      bytes: count(carried.bytes),
    },
    // NOTE: Links written before limits had a scope were the whole
    // account's.
    limit:
      limit && typeof limit === "object" && isAgent(limit.agent)
        ? { ...limit, scope: limit.scope ?? null }
        : null,
    ...(v.thread === true ? { thread: true } : {}),
  };
}

// ─── Threads ────────────────────────────────────────────────────────────────

/** One session of a thread, as {@link HandoffStore.chainOf} lists it. */
export interface ChainSession {
  /** The native session (CLI conversation) id. */
  conversation: string;
  agent: ConversationAgent;
  /**
   * The model it was handed to (a later session), or the one the first
   * session last ran with when it was handed off; null when not known.
   */
  model: string | null;
  /** The handoff that started it; null for the head. */
  link: ConversationHandoff | null;
}

/** The thread links, both ways: at most one each, the latest written. */
interface ThreadIndex {
  /** By the session handed off from. */
  next: Map<string, ConversationHandoff>;
  /** By the session it started. */
  prev: Map<string, ConversationHandoff>;
}

/**
 * The in-place links of `all`, indexed.
 *
 * NOTE: Only `thread` links join sessions into one thread. A handoff to a
 * new conversation (the older `handoff` IPC) leaves two conversations that
 * each keep their own row and id, as they always did.
 */
function threadIndex(all: readonly ConversationHandoff[]): ThreadIndex {
  const next = new Map<string, ConversationHandoff>();
  const prev = new Map<string, ConversationHandoff>();
  for (const link of all) {
    if (!link.thread) continue;
    // A session joins one thread, once, and only as a new session: a
    // second link into it, or one back into a session already handed off
    // (never written by `switchAgent`), is not followed.
    if (prev.has(link.to.conversation) || next.has(link.to.conversation))
      continue;
    next.set(link.from.conversation, link);
    prev.set(link.to.conversation, link);
  }
  return { next, prev };
}

/** The head of `id`'s thread in `index`: `id` itself when it has none. */
function headIn(index: ThreadIndex, id: string): string {
  const seen = new Set<string>([id]);
  let at = id;
  for (;;) {
    const link = index.prev.get(at);
    if (!link || seen.has(link.from.conversation)) return at;
    at = link.from.conversation;
    seen.add(at);
  }
}

/**
 * The sessions of `id`'s thread in `index`, head first; empty when `id` is
 * in none.
 */
function chainIn(index: ThreadIndex, id: string): ChainSession[] {
  const head = headIn(index, id);
  const first = index.next.get(head);
  if (!first) return [];
  const out: ChainSession[] = [
    {
      conversation: head,
      agent: first.from.agent,
      model: first.from.model ?? null,
      link: null,
    },
  ];
  const seen = new Set<string>([head]);
  for (
    let link: ConversationHandoff | undefined = first;
    link && !seen.has(link.to.conversation);
    link = index.next.get(link.to.conversation)
  ) {
    seen.add(link.to.conversation);
    out.push({
      conversation: link.to.conversation,
      agent: link.to.agent,
      model: link.to.model,
      link,
    });
  }
  return out;
}

/**
 * Every handoff made here, kept in `file` (beside the per-conversation
 * settings) so "Handed off from" and "Continued in" survive a restart.
 *
 * Writes are queued one after another; a failed write leaves the memory
 * copy answering this run.
 */
export function createHandoffStore(file: string) {
  let cache: ConversationHandoff[] | null = null;
  let writing: Promise<void> = Promise.resolve();
  /** The thread links of `cache`; null once a record changed them. */
  let index: ThreadIndex | null = null;
  /** Each id's thread, as last asked, until a record changes them. */
  const chains = new Map<string, ChainSession[]>();

  const indexed = (): ThreadIndex => {
    if (!index) index = threadIndex(cache ?? []);
    return index;
  };
  /** `id`'s thread from what is loaded, cached; empty when in none. */
  const chainNow = (id: string): ChainSession[] => {
    const known = chains.get(id);
    if (known) return known;
    const chain = chainIn(indexed(), id);
    if (chains.size > 512) chains.clear();
    chains.set(id, chain);
    return chain;
  };

  async function load(): Promise<ConversationHandoff[]> {
    if (cache) return cache;
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as {
        handoffs?: unknown;
      };
      cache = Array.isArray(value.handoffs)
        ? value.handoffs.flatMap((entry) => {
            const link = storedLink(entry);
            return link ? [link] : [];
          })
        : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  function persist(handoffs: ConversationHandoff[]): void {
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ handoffs }));
        await rename(temp, file);
      })
      .catch(() => {
        // The memory copy still answers this run.
      });
  }

  return {
    async record(link: ConversationHandoff): Promise<void> {
      const all = [...(await load()), link];
      // NOTE: Threads are never cut short: the oldest links that are no
      // thread's go first, so a long-lived thread keeps its whole chain.
      let over = all.length - KEEP;
      const kept = all.filter((entry) => {
        if (over <= 0 || entry.thread) return true;
        over--;
        return false;
      });
      cache = kept.slice(Math.max(0, kept.length - KEEP));
      index = null;
      chains.clear();
      persist(cache);
    },
    /** Read the file, once: the sync `now` answers from what it holds. */
    ready: async (): Promise<void> => {
      await load();
    },
    /**
     * `id`'s thread in `project`, head first, each session with its agent
     * and model; empty when `id` is in none (a lone conversation).
     */
    async chainOf(project: string, id: string): Promise<ChainSession[]> {
      await load();
      const chain = chainNow(id);
      return chain[1]?.link?.project === project ? chain : [];
    },
    /** The head of `id`'s thread (its first session): `id` when in none. */
    async headOf(id: string): Promise<string> {
      await load();
      return headIn(indexed(), id);
    },
    /** The newest session of `id`'s thread: `id` when in none. */
    async newestOf(id: string): Promise<string> {
      await load();
      return chainNow(id).at(-1)?.conversation ?? id;
    },
    /**
     * The same answers from what is loaded, without waiting: for an event
     * on its way out. Before {@link ready}, every id is its own thread.
     */
    now: {
      chainOf: (id: string): ChainSession[] => (cache ? chainNow(id) : []),
      headOf: (id: string): string => (cache ? headIn(indexed(), id) : id),
      newestOf: (id: string): string =>
        (cache ? chainNow(id).at(-1)?.conversation : undefined) ?? id,
    },
    async links(
      project: string,
      conversation: string,
    ): Promise<ConversationHandoffLinks> {
      const all = await load();
      return {
        from:
          all[
            lastIndexOf(
              all,
              (link) =>
                link.project === project &&
                link.to.conversation === conversation,
            )
          ] ?? null,
        to: all.filter(
          (link) =>
            link.project === project && link.from.conversation === conversation,
        ),
      };
    },
    flushed: () => writing,
  };
}
