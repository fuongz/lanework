// One conversation's numbers, read for the agent view (FE-38): its model,
// cost, tokens, context, lines changed, run time and Claude's newest recap.
// Also a project's totals of them, for Settings (FE-38/D6), OpenCode's
// included (FE-105/D8).
//
// Read-only, and nothing here imports Electron: main calls it, and a spec can
// drive it under plain Node against a fake home folder.
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AGENT_FACTS_READ_MAX,
  AGENT_USAGE_DAYS,
  type AgentFacts,
  type AgentUsage,
  type AgentUsageTotals,
  isAgentSessionId,
  isAgentSessionIdOf,
  isTerminalAgent,
  type TerminalAgent,
} from "../../../shared/terminal";
import {
  claudeProjectDir,
  codexRolloutOf,
  codexRollouts,
  type Line,
  lines,
  readRange,
} from "./agent-sessions";
import { opencodeFacts, opencodeUsage } from "./opencode-details";
import { opencodeDataDirOf } from "./opencode-sessions";

/** How much of a transcript one step back reads. */
const CHUNK = 64 * 1024;
/** One day, in ms. */
const DAY = 24 * 60 * 60_000;

/** What the agent view asks for, checked. */
interface FactsRequest {
  project: string;
  agent: TerminalAgent;
  id: string;
}

/**
 * The request off the wire: ids, never a path.
 *
 * NOTE: The conversation is of the shape its CLI writes and nothing else
 * ({@link isAgentSessionIdOf}: a UUID, or OpenCode's `ses_…`), as a resume
 * id is, so it can be no `..`, separator or absolute path. The path is built
 * from it by {@link readAgentFacts}, inside the CLI's folder; OpenCode's is a
 * bound value of a query (FE-104).
 *
 * @throws when any of the three arguments is missing or invalid.
 */
export function factsRequest(args: unknown[]): FactsRequest {
  if (args.length !== 3)
    throw new Error("A project, an agent and a conversation are required");
  const [project, agent, id] = args;
  if (typeof project !== "string" || !project.trim() || project.length > 200)
    throw new Error("A valid project is required");
  if (!isTerminalAgent(agent)) throw new Error("A valid agent is required");
  if (!isAgentSessionIdOf(agent, id))
    throw new Error("A valid conversation is required");
  return { project, agent, id };
}

/**
 * How a read back ended.
 *
 * - `enough`: the visitor said it had enough.
 * - `start`: the read reached the file's start.
 * - `cap`: the read stopped at its byte cap.
 */
type Ended = "enough" | "start" | "cap";

/**
 * Visit `handle`'s lines between byte `floor` and `size`, newest first, until
 * `visit` says it has enough.
 *
 * The file is read back from its end {@link CHUNK} bytes at a time, at most
 * `max` bytes of it.
 *
 * Lines are passed as raw bytes with where each begins, so `visit` can tell a
 * line is none of its business before paying to parse it. A chunk's first
 * line is cut, and waits for the chunk before it; at the cap that cut line is
 * dropped, never guessed at. `floor` is a line's start (0, or what an earlier
 * pass ended its whole lines at), so the line it begins is whole. The newest
 * line may still be being written: `complete` is false for it, and it may
 * fail to parse, and be skipped.
 *
 * @param visit Returns true once it has enough.
 * @returns Where the whole lines end: `size` for a file that ends in a
 *   newline, or where its last, unfinished line begins. null when the read
 *   ended before telling.
 */
async function scanBack(
  handle: FileHandle,
  size: number,
  floor: number,
  max: number,
  visit: (line: Buffer, at: number, complete: boolean) => boolean,
): Promise<number | null> {
  let end = size;
  let carry = Buffer.alloc(0);
  let read = 0;
  let wholeEnd: number | null = size === floor ? size : null;
  const send = (piece: Buffer, at: number): boolean => {
    const complete = at + piece.length < size;
    if (!complete) wholeEnd = at;
    return visit(piece, at, complete);
  };
  while (end > floor) {
    if (read >= max) return wholeEnd;
    const length = Math.min(CHUNK, end - floor, max - read);
    const start = end - length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, start);
    read += length;
    if (end === size && bytesRead > 0 && chunk[bytesRead - 1] === 0x0a)
      wholeEnd = size;
    const buffer = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
    let stop = buffer.length;
    // NOTE: Never `lastIndexOf(…, -1)`: a negative offset counts from the
    // END.
    while (stop > 0) {
      const newline = buffer.lastIndexOf(0x0a, stop - 1);
      if (newline === -1) break;
      if (
        newline + 1 < stop &&
        send(buffer.subarray(newline + 1, stop), start + newline + 1)
      )
        return wholeEnd;
      stop = newline;
    }
    carry = buffer.subarray(0, stop);
    end = start;
  }
  if (carry.length > 0) send(carry, floor);
  return wholeEnd;
}

/**
 * What a kind of facts folds out of a transcript, one layer of notes at a
 * time (see {@link scanFacts}).
 *
 * Notes are kept with where each was found, so that a later pass can drop
 * what slid out of the read window instead of guessing.
 */
interface Fold<N> {
  blank(): N;
  /** Fold one line, from the newest on, into `notes`. */
  visit(notes: N, piece: Buffer, at: number): void;
  /** `newer` laid over `older`: what a read through both would have found. */
  over(newer: N, older: N): N;
  /**
   * `notes` as a read of the window from byte `window` on would have them,
   * or null when that is not told by the notes alone (rescan, then).
   */
  within(notes: N, window: number): N | null;
  /**
   * The newer notes alone say enough: nothing further back changes them.
   *
   * NOTE: Never judged by older notes too: the newer bytes may still hold
   * something newer than what those say.
   */
  enough(tail: N, scan: N): boolean;
  /**
   * `notes` cannot be told apart from a read of the whole window, because the
   * bytes before `reach` were never looked at and what they hold could
   * matter now: rescan.
   */
  unsure?(notes: N, reach: number, window: number): boolean;
}

/** Something found, and where its line begins in the file. */
interface Hit<T> {
  value: T;
  at: number;
}

/** Whether a hit lies inside the window a read from byte `window` has. */
const kept = (hit: Hit<unknown> | null, window: number): boolean =>
  hit !== null && (window === 0 || hit.at > window);

/** What a pass over a transcript left, to be extended by the next. */
interface Cached<N> {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Where the notes' whole lines end; the next pass starts there. */
  wholeEnd: number;
  /** The lowest byte looked at: a pass that had enough stops short of 0. */
  reach: number;
  /** The whole lines' notes, the file's unfinished last line left out. */
  notes: N;
  /** All of it, that last line too: what is answered while nothing grew. */
  view: N;
  ended: Ended;
}

/** The transcripts passed over, newest used last. */
const passes = new Map<string, Cached<never>>();
/** Most transcripts remembered. */
const PASSES_MAX = 128;

/**
 * `file`'s notes, folded from its end.
 *
 * NOTE: A write is followed by a read of the same transcript, and each read
 * back cost up to {@link AGENT_FACTS_READ_MAX}. A transcript is only ever
 * appended to, so the notes of the last pass are kept by path, with where its
 * whole lines ended, and a pass reads only the bytes past that, laid over
 * them. The result is what a read of the whole window would give. A pass goes
 * back to the whole window when:
 * - the file is another one (device or inode), or shorter than the last pass
 *   saw, or the byte before the stored end is no newline: it was replaced;
 * - the appended bytes are as long as the window: nothing is gained;
 * - a note that slid out of the window is the cost line, which the answers
 *   newer than it were counted against (see `within`).
 * Nothing grew (same size and mtime): the last answer is given again, no read.
 *
 * @param key Where the notes are kept: the file, and what is asked of it.
 */
async function scanFacts<N>(
  file: string,
  fold: Fold<N>,
  key: string,
): Promise<{ notes: N; ended: Ended }> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const { size } = info;
    const window = size - Math.min(size, AGENT_FACTS_READ_MAX);
    const last = passes.get(key) as Cached<N> | undefined;
    const same =
      last !== undefined && last.dev === info.dev && last.ino === info.ino;
    if (last && same && last.size === size && last.mtimeMs === info.mtimeMs) {
      passes.delete(key);
      passes.set(key, last as Cached<never>);
      return { notes: last.view, ended: last.ended };
    }
    // NOTE: The second round is a read of the whole window, for when the
    // first cannot tell (see `Fold.unsure`).
    for (const again of [last && same, false]) {
      let floor = 0;
      let older = fold.blank();
      let oldReach = 0;
      if (
        again &&
        last &&
        size >= last.wholeEnd &&
        (window === 0 || last.wholeEnd > window)
      ) {
        // The byte before the stored end is the newline of the line it closed.
        const probe = Buffer.alloc(1);
        const there =
          last.wholeEnd === 0
            ? { bytesRead: 1 }
            : await handle.read(probe, 0, 1, last.wholeEnd - 1);
        const cut = fold.within(last.notes, window);
        if (
          cut &&
          there.bytesRead === 1 &&
          (last.wholeEnd === 0 || probe[0] === 0x0a)
        ) {
          floor = last.wholeEnd;
          older = cut;
          oldReach = last.reach;
        }
      }
      const tail = fold.blank();
      const scan = fold.blank();
      let lowest = size;
      let stopped = false;
      const wholeEnd = await scanBack(
        handle,
        size,
        floor,
        AGENT_FACTS_READ_MAX,
        (piece, at, complete) => {
          fold.visit(complete ? scan : tail, piece, at);
          lowest = at;
          stopped = fold.enough(tail, scan);
          return stopped;
        },
      );
      // NOTE: A pass that had enough stopped where a read of the whole window
      // would have: nothing older is looked at, and the notes of the pass
      // before say nothing of what lies between.
      const notes = fold.over(scan, stopped ? fold.blank() : older);
      const view = fold.over(tail, notes);
      // Where a read of the window would have got to.
      const reach = stopped ? lowest : floor > 0 ? oldReach : window;
      if (floor > 0 && fold.unsure?.(view, reach, window)) continue;
      const ended: Ended = fold.enough(fold.blank(), view)
        ? "enough"
        : window > 0
          ? "cap"
          : "start";
      passes.delete(key);
      if (wholeEnd !== null) {
        passes.set(key, {
          dev: info.dev,
          ino: info.ino,
          size,
          mtimeMs: info.mtimeMs,
          wholeEnd,
          reach,
          notes,
          view,
          ended,
        } as Cached<never>);
        if (passes.size > PASSES_MAX)
          passes.delete(passes.keys().next().value as string);
      }
      return { notes: view, ended };
    }
    throw new Error("unreachable");
  } finally {
    await handle.close();
  }
}

/**
 * One line, parsed.
 *
 * @returns null for a line cut short, or not a JSON object.
 */
function parse(piece: Buffer): Line | null {
  try {
    const value: unknown = JSON.parse(piece.toString("utf8"));
    return value && typeof value === "object" ? (value as Line) : null;
  } catch {
    return null;
  }
}

/** A positive finite number, or 0 for anything else. */
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** A non-blank string, trimmed, or null. */
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The tokens of one answer. */
interface Usage {
  input: number;
  cached: number;
  output: number;
}

/**
 * A positive number, or null.
 *
 * A 0 means "none written" here, and is never shown (FE-38/D1).
 */
const some = (value: number): number | null => (value > 0 ? value : null);

/** What a pass over a Claude transcript found, each with where. */
interface ClaudeNotes {
  cost: Hit<Line> | null;
  /** The newest answer that names a model. */
  answered: Hit<string> | null;
  /** The newest attachment that names the model the CLI started on. */
  attached: Hit<string> | null;
  context: Hit<number> | null;
  recap: Hit<NonNullable<AgentFacts["recap"]>> | null;
  /** The answers newer than `cost`, by message id. */
  since: Map<string, Hit<Usage>>;
}

/**
 * The model the notes say.
 *
 * NOTE: The newest of the two, as a read that takes the first it meets goes
 * back. An answer is looked at only while the cost line or the context is
 * still unknown (see `visit`), so one older than both is not seen by a read
 * of the whole, and no notes of an earlier pass may say it either.
 */
function modelOf(notes: {
  cost: Hit<unknown> | null;
  context: Hit<unknown> | null;
  answered: Hit<string> | null;
  attached: Hit<string> | null;
}): Hit<string> | null {
  const seen = Math.min(
    notes.cost?.at ?? Number.NEGATIVE_INFINITY,
    notes.context?.at ?? Number.NEGATIVE_INFINITY,
  );
  const answer =
    notes.answered && notes.answered.at >= seen ? notes.answered : null;
  if (answer && notes.attached)
    return answer.at > notes.attached.at ? answer : notes.attached;
  return answer ?? notes.attached;
}

/** The notes of a Claude transcript, as `full` or not (see {@link claudeFacts}). */
const claudeFold = (full: boolean): Fold<ClaudeNotes> => ({
  blank: () => ({
    cost: null,
    answered: null,
    attached: null,
    context: null,
    recap: null,
    since: new Map(),
  }),
  visit(notes, piece, at) {
    // Cheap tells first: most lines are none of what is looked for.
    const wanted =
      (notes.cost === null && piece.includes('"cost-state"')) ||
      (full && notes.recap === null && piece.includes('"away_summary"')) ||
      ((notes.cost === null || notes.context === null) &&
        piece.includes('"assistant"')) ||
      (notes.attached === null && piece.includes('"attachment"'));
    const line = wanted ? parse(piece) : null;
    if (line?.type === "cost-state") notes.cost ??= { value: line, at };
    else if (line?.type === "system" && line.subtype === "away_summary") {
      const text = str(line.content);
      if (full && text && notes.recap === null)
        notes.recap = {
          value: {
            text,
            at: typeof line.timestamp === "string" ? line.timestamp : null,
          },
          at,
        };
    } else if (line?.type === "assistant" && !line.isSidechain) {
      const message = (line.message ?? {}) as {
        id?: unknown;
        model?: unknown;
        usage?: Record<string, unknown>;
      };
      const named = str(message.model);
      // `<synthetic>`: the CLI's own stand-in for an answer, no model's.
      if (notes.answered === null && named && !named.startsWith("<"))
        notes.answered = { value: named, at };
      const usage = message.usage;
      if (usage) {
        const cached = count(usage.cache_read_input_tokens);
        const input =
          count(usage.input_tokens) +
          cached +
          count(usage.cache_creation_input_tokens);
        const output = count(usage.output_tokens);
        if (notes.context === null && input > 0)
          notes.context = { value: input, at };
        // A line with no id is its own answer: where it begins names it.
        const key = typeof message.id === "string" ? message.id : `#${at}`;
        if (notes.cost === null && input + output > 0 && !notes.since.has(key))
          notes.since.set(key, { value: { input, cached, output }, at });
      }
    } else if (line?.type === "attachment" && notes.attached === null) {
      // The model the CLI started on, when no answer read so far says.
      const attachment = line.attachment as {
        type?: unknown;
        identity?: { modelId?: unknown };
      } | null;
      const modelId =
        attachment?.type === "model" ? str(attachment.identity?.modelId) : null;
      if (modelId) notes.attached = { value: modelId, at };
    }
  },
  over(newer, older) {
    const since = new Map(newer.since);
    // Answers are counted against the newest cost line only: older ones were
    // counted against a cost line the newer bytes have replaced.
    if (newer.cost === null)
      for (const [key, hit] of older.since)
        if (!since.has(key)) since.set(key, hit);
    return {
      cost: newer.cost ?? older.cost,
      answered: newer.answered ?? older.answered,
      attached: newer.attached ?? older.attached,
      context: newer.context ?? older.context,
      recap: newer.recap ?? older.recap,
      since,
    };
  },
  within(notes, window) {
    // The answers a read of the window counts are the ones newer than its
    // cost line; one that left the window takes that count with it.
    if (notes.cost && !kept(notes.cost, window)) return null;
    const since = new Map<string, Hit<Usage>>();
    for (const [key, hit] of notes.since)
      if (kept(hit, window)) since.set(key, hit);
    return {
      cost: notes.cost,
      answered: kept(notes.answered, window) ? notes.answered : null,
      attached: kept(notes.attached, window) ? notes.attached : null,
      context: kept(notes.context, window) ? notes.context : null,
      recap: kept(notes.recap, window) ? notes.recap : null,
      since,
    };
  },
  unsure(notes, reach, window) {
    // An answer is looked at only while the cost line or the context is
    // unknown, so a newer one found since may have ruled out the answer that
    // let an earlier pass stop; the attachment's model it would then have
    // gone on to was never looked for.
    if (!full || notes.attached !== null || reach <= window) return false;
    const answer = modelOf({ ...notes, attached: null });
    return answer === null;
  },
  enough(tail, scan) {
    return (
      (tail.cost ?? scan.cost) !== null &&
      (!full ||
        ((tail.context ?? scan.context) !== null &&
          (tail.recap ?? scan.recap) !== null &&
          modelOf({
            cost: tail.cost ?? scan.cost,
            context: tail.context ?? scan.context,
            answered: tail.answered ?? scan.answered,
            attached: tail.attached ?? scan.attached,
          }) !== null))
    );
  },
});

/**
 * A Claude transcript's numbers, read from its end.
 *
 * NOTE: `cost-state` is Claude's own running total of the conversation
 * (cost, tokens by model, lines, durations). It is written when Claude is
 * left or quit, NOT after every turn, so a conversation running now may have
 * none yet, or one several turns old. The answers written after the newest
 * one are added to its tokens, once each, since Claude writes an answer as
 * several lines that share its `message.id`. `stale` says the rest lag.
 *
 * The context is the newest answer's own input: what that turn sent the
 * model. Claude records no window size, so none is guessed (FE-38/D2).
 *
 * @param full Read back until the model, the context and the newest recap
 *   are found too, not only the newest `cost-state`.
 */
async function claudeFacts(
  file: string,
  { full }: { full: boolean },
): Promise<AgentFacts> {
  const { notes, ended } = await scanFacts(
    file,
    claudeFold(full),
    `claude\0${full}\0${file}`,
  );
  const model = modelOf(notes)?.value ?? null;
  const context = notes.context?.value ?? null;
  const recap = notes.recap?.value ?? null;
  const since = new Map([...notes.since].map(([key, hit]) => [key, hit.value]));

  const after = [...since.values()].reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      cached: sum.cached + usage.cached,
      output: sum.output + usage.output,
    }),
    { input: 0, cached: 0, output: 0 },
  );
  const saved = notes.cost?.value ?? null;
  let tokens: AgentFacts["tokens"] = null;
  if (saved) {
    const total = { ...after };
    for (const usage of Object.values(
      (saved.modelUsage ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      const cached = count(usage?.cacheReadInputTokens);
      total.input +=
        count(usage?.inputTokens) +
        cached +
        count(usage?.cacheCreationInputTokens);
      total.cached += cached;
      total.output += count(usage?.outputTokens);
    }
    tokens = total;
    // Without a `cost-state`, the answers are all there is, and only a read
    // that reached the start has them all: a capped one would undercount.
  } else if (ended !== "cap") tokens = after;
  if (tokens && tokens.input + tokens.output === 0) tokens = null;

  const added = count(saved?.totalLinesAdded);
  const removed = count(saved?.totalLinesRemoved);
  const wall = count(saved?.totalDuration);
  return {
    agent: "claude",
    model,
    effort: null,
    costUSD: some(count(saved?.totalCostUSD)),
    stale: saved !== null && since.size > 0,
    tokens,
    context: context === null ? null : { tokens: context, window: null },
    lines: added + removed > 0 ? { added, removed } : null,
    duration:
      wall > 0
        ? {
            wall,
            api: count(saved?.totalAPIDuration),
            tools: count(saved?.totalToolDuration),
          }
        : null,
    recap,
    partial: ended === "cap",
  };
}

/** What a pass over a Codex rollout found, each with where. */
interface CodexNotes {
  info: Hit<Record<string, unknown>> | null;
  turn: Hit<Record<string, unknown>> | null;
}

const codexFold: Fold<CodexNotes> = {
  blank: () => ({ info: null, turn: null }),
  visit(notes, piece, at) {
    const wanted =
      (notes.info === null && piece.includes('"token_count"')) ||
      (notes.turn === null && piece.includes('"turn_context"'));
    const line = wanted ? parse(piece) : null;
    const payload = line?.payload as Record<string, unknown> | undefined;
    if (
      line?.type === "event_msg" &&
      payload?.type === "token_count" &&
      payload.info &&
      typeof payload.info === "object"
    )
      notes.info ??= { value: payload.info as Record<string, unknown>, at };
    else if (line?.type === "turn_context" && payload)
      notes.turn ??= { value: payload, at };
  },
  over: (newer, older) => ({
    info: newer.info ?? older.info,
    turn: newer.turn ?? older.turn,
  }),
  within: (notes, window) => ({
    info: kept(notes.info, window) ? notes.info : null,
    turn: kept(notes.turn, window) ? notes.turn : null,
  }),
  enough: (tail, scan) =>
    (tail.info ?? scan.info) !== null && (tail.turn ?? scan.turn) !== null,
};

/**
 * A Codex rollout's numbers, read from its end.
 *
 * - The newest `token_count`: the running total for the whole thread, the
 *   newest turn's own input as the context, and the window when Codex says
 *   it.
 * - The newest `turn_context`: the model and effort.
 *
 * Codex records no cost and no recap.
 *
 * A `token_count` whose `info` is null says nothing: the one before it is the
 * newest that does. `model_context_window` may be missing; then the context
 * is a count with no percentage (FE-38/D2).
 */
async function codexFacts(file: string): Promise<AgentFacts> {
  const { notes, ended } = await scanFacts(file, codexFold, `codex\0${file}`);
  const info = notes.info?.value ?? null;
  const turn = notes.turn?.value ?? null;
  const read = info as Record<string, unknown> | null;
  const total = (read?.total_token_usage ?? {}) as Record<string, unknown>;
  const last = (read?.last_token_usage ?? {}) as Record<string, unknown>;
  const input = count(total.input_tokens);
  const output = count(total.output_tokens);
  const context = count(last.input_tokens);
  const turned = turn as Record<string, unknown> | null;
  return {
    agent: "codex",
    model: str(turned?.model),
    effort: str(turned?.effort),
    costUSD: null,
    stale: false,
    tokens:
      input + output > 0
        ? { input, output, cached: count(total.cached_input_tokens) }
        : null,
    context:
      context > 0
        ? { tokens: context, window: some(count(read?.model_context_window)) }
        : null,
    lines: null,
    duration: null,
    recap: null,
    partial: ended === "cap",
  };
}

/**
 * The folder a Claude transcript says it was written in.
 *
 * NOTE: Claude's folder name is lossy (`a_b` and `a-b` are both `a-b`), so a
 * transcript under this folder's name may be another folder's. The listing
 * reads the same line for the same reason.
 *
 * @returns `undefined` when the transcript's head names none.
 */
async function claudeCwd(file: string): Promise<unknown> {
  const head = lines(await readRange(file, 0, CHUNK), { head: true });
  return head.find((line) => typeof line.cwd === "string")?.cwd;
}

/** Codex rollouts found by conversation, kept for the view's next read. */
const codexFiles = new Map<string, string>();

/**
 * The rollout of Codex conversation `id`, if it is one of `folder`'s.
 *
 * It is found by its file's name among the newest rollouts, then confirmed
 * by its `session_meta`.
 *
 * @throws when no rollout of `folder` is that conversation.
 */
async function codexConversationFile(
  home: string,
  folder: string,
  id: string,
): Promise<string> {
  const key = `${folder}\0${id}`;
  const known = codexFiles.get(key);
  if (known && (await stat(known).catch(() => null))?.isFile()) return known;
  codexFiles.delete(key);
  for (const file of await codexRollouts(join(home, ".codex", "sessions"))) {
    if (!basename(file).endsWith(`-${id}.jsonl`)) continue;
    const rollout = await codexRolloutOf(file, folder);
    if (!rollout || rollout.id !== id || rollout.parent !== null) continue;
    codexFiles.set(key, file);
    return file;
  }
  throw new Error("That conversation is not one of this project's.");
}

/**
 * The numbers of `agent`'s conversation `id` in `folder`, for the agent view
 * and the rail.
 *
 * NOTE: The id is checked again here, and the path built from it inside the
 * CLI's own folder under `home`: Claude's `projects/<folder>/<id>.jsonl`, or
 * a rollout whose own `session_meta` says it is that conversation of this
 * folder.
 *
 * @throws when the conversation is not one of `folder`'s.
 */
export async function readAgentFacts(
  home: string,
  folder: string,
  agent: TerminalAgent,
  id: string,
): Promise<AgentFacts> {
  factsRequest(["-", agent, id]);
  if (agent === "opencode")
    return opencodeFacts(opencodeDataDirOf(home), folder, id);
  if (agent === "codex")
    return codexFacts(await codexConversationFile(home, folder, id));
  const file = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${id}.jsonl`,
  );
  const cwd = await claudeCwd(file).catch(() => {
    throw new Error("That conversation is not one of this project's.");
  });
  if (cwd !== undefined && cwd !== folder)
    throw new Error("That conversation is not one of this project's.");
  return claudeFacts(file, { full: true });
}

/** Empty totals for one CLI in one window. */
const none = (): AgentUsageTotals => ({
  conversations: 0,
  costUSD: null,
  input: 0,
  output: 0,
});

/**
 * `folder`'s agent usage over each window of {@link AGENT_USAGE_DAYS}
 * (FE-38/D6).
 *
 * A transcript falls in a window by when it was last written. Each window
 * holds Claude's cost estimate, both CLIs' tokens, and how many
 * conversations.
 *
 * NOTE: Every transcript written in the window is read, from its end as far
 * as its newest `cost-state`, so this runs only when Settings asks, never
 * with the listing.
 *
 * - A conversation written to in the window counts WHOLE, however long ago
 *   it began.
 * - A Claude conversation's own totals hold its sub-agents' (FE-38/V5).
 * - A Codex thread's spawns are rollouts of their own, counted for their
 *   tokens but not as conversations.
 * - OpenCode's are rows of its database, read in one query: a top-level
 *   session is a conversation, and the sessions under it add to its totals
 *   (FE-105/D8). None is ever too long to read.
 * - A conversation whose totals a read cannot reach is left out, and counted
 *   in `skipped`.
 */
export async function readAgentUsage(
  home: string,
  folder: string,
  now = Date.now(),
): Promise<AgentUsage> {
  const windows = AGENT_USAGE_DAYS.map((days) => ({
    days,
    from: now - days * DAY,
    claude: none(),
    codex: none(),
    opencode: none(),
  }));
  const oldest = Math.min(...windows.map((window) => window.from));
  let skipped = 0;
  const add = (
    agent: "claude" | "codex" | "opencode",
    at: number,
    facts: Pick<AgentFacts, "tokens" | "costUSD">,
    conversation: boolean,
  ) => {
    const put = (totals: AgentUsageTotals) => {
      if (conversation) totals.conversations++;
      totals.input += facts.tokens?.input ?? 0;
      totals.output += facts.tokens?.output ?? 0;
      if (facts.costUSD !== null)
        totals.costUSD = (totals.costUSD ?? 0) + facts.costUSD;
    };
    for (const window of windows) if (at >= window.from) put(window[agent]);
  };

  const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const id = name.slice(0, -".jsonl".length);
    if (!name.endsWith(".jsonl") || !isAgentSessionId(id)) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.mtimeMs < oldest) continue;
      const cwd = await claudeCwd(file);
      if (cwd !== undefined && cwd !== folder) continue;
      const facts = await claudeFacts(file, { full: false });
      if (facts.tokens === null && facts.costUSD === null) {
        if (facts.partial) skipped++;
        continue;
      }
      add("claude", info.mtimeMs, facts, true);
    } catch {
      // Gone, or being written: the next one.
    }
  }

  for (const file of await codexRollouts(join(home, ".codex", "sessions"))) {
    try {
      const info = await stat(file);
      if (info.mtimeMs < oldest) continue;
      const rollout = await codexRolloutOf(file, folder);
      if (!rollout) continue;
      const facts = await codexFacts(file);
      if (facts.tokens === null) {
        if (facts.partial) skipped++;
        continue;
      }
      add("codex", info.mtimeMs, facts, rollout.parent === null);
    } catch {
      // Gone, or being written: the next one.
    }
  }

  // NOTE: The environment's data folder counts only for the real home, so a
  // spec's fake home never reads this machine's OpenCode.
  for (const row of await opencodeUsage(
    opencodeDataDirOf(home),
    folder,
    oldest,
  )) {
    // The totals keep no cached count, so none is read.
    const tokens = { input: row.input, output: row.output, cached: 0 };
    add("opencode", row.updated, { tokens, costUSD: row.costUSD }, true);
  }

  return {
    windows: windows.map(({ days, claude, codex, opencode }) => ({
      days,
      claude,
      codex,
      opencode,
    })),
    skipped,
  };
}
