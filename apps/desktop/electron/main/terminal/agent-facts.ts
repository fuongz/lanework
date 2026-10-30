// One conversation's numbers, read for the agent view (FE-38): its model,
// cost, tokens, context, lines changed, run time and Claude's newest recap.
// Also a project's totals of them, for Settings (FE-38/D6), OpenCode's
// included (FE-105/D8).
//
// Read-only, and nothing here imports Electron: main calls it, and a spec can
// drive it under plain Node against a fake home folder.
import { open, readdir, stat } from "node:fs/promises";
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
 * Visit `file`'s lines, newest first, until `visit` says it has enough.
 *
 * The file is read back from its end {@link CHUNK} bytes at a time, at most
 * `max` bytes of it.
 *
 * Lines are passed as raw bytes, so `visit` can tell a line is none of its
 * business before paying to parse it. A chunk's first line is cut, and waits
 * for the chunk before it; at the cap that cut line is dropped, never guessed
 * at. The newest line may still be being written: it fails to parse, and is
 * skipped.
 *
 * @param visit Returns true once it has enough.
 */
async function readBack(
  file: string,
  visit: (line: Buffer) => boolean,
  max = AGENT_FACTS_READ_MAX,
): Promise<Ended> {
  const handle = await open(file, "r");
  try {
    let end = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    let read = 0;
    while (end > 0) {
      if (read >= max) return "cap";
      const length = Math.min(CHUNK, end, max - read);
      const start = end - length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      read += length;
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      let stop = buffer.length;
      // NOTE: Never `lastIndexOf(…, -1)`: a negative offset counts from the
      // END.
      while (stop > 0) {
        const newline = buffer.lastIndexOf(0x0a, stop - 1);
        if (newline === -1) break;
        if (newline + 1 < stop && visit(buffer.subarray(newline + 1, stop)))
          return "enough";
        stop = newline;
      }
      carry = buffer.subarray(0, stop);
      end = start;
    }
    if (carry.length > 0 && visit(carry)) return "enough";
    return "start";
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
  let cost: Line | null = null;
  let model: string | null = null;
  let context: number | null = null;
  let recap: AgentFacts["recap"] = null;
  // The answers newer than `cost`, by message id.
  const since = new Map<string, Usage>();
  let seen = 0;
  const ended = await readBack(file, (piece) => {
    seen++;
    // Cheap tells first: most lines are none of what is looked for.
    const wanted =
      (cost === null && piece.includes('"cost-state"')) ||
      (full && recap === null && piece.includes('"away_summary"')) ||
      ((cost === null || context === null) && piece.includes('"assistant"')) ||
      (model === null && piece.includes('"attachment"'));
    const line = wanted ? parse(piece) : null;
    if (line?.type === "cost-state") cost ??= line;
    else if (line?.type === "system" && line.subtype === "away_summary") {
      const text = str(line.content);
      if (full && text && recap === null)
        recap = {
          text,
          at: typeof line.timestamp === "string" ? line.timestamp : null,
        };
    } else if (line?.type === "assistant" && !line.isSidechain) {
      const message = (line.message ?? {}) as {
        id?: unknown;
        model?: unknown;
        usage?: Record<string, unknown>;
      };
      const named = str(message.model);
      // `<synthetic>`: the CLI's own stand-in for an answer, no model's.
      if (model === null && named && !named.startsWith("<")) model = named;
      const usage = message.usage;
      if (usage) {
        const cached = count(usage.cache_read_input_tokens);
        const input =
          count(usage.input_tokens) +
          cached +
          count(usage.cache_creation_input_tokens);
        const output = count(usage.output_tokens);
        if (context === null && input > 0) context = input;
        const key = typeof message.id === "string" ? message.id : `#${seen}`;
        if (cost === null && input + output > 0 && !since.has(key))
          since.set(key, { input, cached, output });
      }
    } else if (line?.type === "attachment" && model === null) {
      // The model the CLI started on, when no answer read so far says.
      const attachment = line.attachment as {
        type?: unknown;
        identity?: { modelId?: unknown };
      } | null;
      if (attachment?.type === "model")
        model = str(attachment.identity?.modelId);
    }
    return (
      cost !== null &&
      (!full || (context !== null && model !== null && recap !== null))
    );
  });

  const after = [...since.values()].reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      cached: sum.cached + usage.cached,
      output: sum.output + usage.output,
    }),
    { input: 0, cached: 0, output: 0 },
  );
  const saved = cost as Line | null;
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
  let info: Record<string, unknown> | null = null;
  let turn: Record<string, unknown> | null = null;
  const ended = await readBack(file, (piece) => {
    const wanted =
      (info === null && piece.includes('"token_count"')) ||
      (turn === null && piece.includes('"turn_context"'));
    const line = wanted ? parse(piece) : null;
    const payload = line?.payload as Record<string, unknown> | undefined;
    if (
      line?.type === "event_msg" &&
      payload?.type === "token_count" &&
      payload.info &&
      typeof payload.info === "object"
    )
      info ??= payload.info as Record<string, unknown>;
    else if (line?.type === "turn_context" && payload) turn ??= payload;
    return info !== null && turn !== null;
  });
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
