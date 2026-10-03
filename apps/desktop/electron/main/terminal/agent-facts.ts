// One conversation's numbers, read for the agent view (FE-38): its model,
// cost, tokens, context, lines changed, run time and Claude's newest recap —
// and a project's totals of them, for Settings (FE-38/D6).
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a spec
// can drive it under plain Node against a fake home folder.
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AGENT_FACTS_READ_MAX,
  AGENT_USAGE_DAYS,
  type AgentFacts,
  type AgentUsage,
  type AgentUsageTotals,
  isAgentSessionId,
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

/** How much of a transcript one step back reads. */
const CHUNK = 64 * 1024;
const DAY = 24 * 60 * 60_000;

/** What the agent view asks for, checked. */
export interface FactsRequest {
  workspace: string;
  agent: TerminalAgent;
  id: string;
}

/**
 * The request off the wire: ids, never a path (FE-38).
 *
 * ⚠️ The conversation is a UUID and nothing else, as a resume id is — so it
 * can be no `..`, separator or absolute path. The path is built from it by
 * `readAgentFacts`, inside the CLI's folder.
 */
export function factsRequest(args: unknown[]): FactsRequest {
  if (args.length !== 3)
    throw new Error("A workspace, an agent and a conversation are required");
  const [workspace, agent, id] = args;
  if (
    typeof workspace !== "string" ||
    !workspace.trim() ||
    workspace.length > 200
  )
    throw new Error("A valid workspace is required");
  if (agent !== "claude" && agent !== "codex")
    throw new Error("A valid agent is required");
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  return { workspace, agent, id };
}

/** How a read back ended: told it had enough, at the file's start, or at the cap. */
type Ended = "enough" | "start" | "cap";

/**
 * `file`'s lines, newest first, read back from its end `CHUNK` at a time
 * until `visit` says it has enough — at most `max` bytes of it.
 *
 * ⚠️ Raw bytes, so `visit` can tell a line is none of its business before
 * paying to parse it. A chunk's first line is cut, and waits for the chunk
 * before it; at the cap that cut line is dropped, never guessed at. The
 * newest line may still be being written: it fails to parse, and is skipped.
 */
export async function readBack(
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
      // ⚠️ Never `lastIndexOf(…, -1)`: a negative offset counts from the END.
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

/** One line, parsed; null for one cut short or not JSON. */
function parse(piece: Buffer): Line | null {
  try {
    const value: unknown = JSON.parse(piece.toString("utf8"));
    return value && typeof value === "object" ? (value as Line) : null;
  } catch {
    return null;
  }
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

interface Usage {
  input: number;
  cached: number;
  output: number;
}

/** Positive, or null: a 0 is "none written" here, never shown (FE-38/D1). */
const some = (value: number): number | null => (value > 0 ? value : null);

/**
 * A Claude transcript's numbers, from its end (FE-38).
 *
 * ⚠️ `cost-state` is Claude's own running total of the conversation — cost,
 * tokens by model, lines, durations — but it is written when Claude is left
 * or quit, NOT after every turn: a conversation running now may have none
 * yet, or one several turns old. So the answers written after the newest one
 * are added to its tokens (once each: Claude writes an answer as several
 * lines that share its `message.id`), and `stale` says the rest lag. Read
 * back no further than that `cost-state` — or, with `full`, the newest
 * recap, wherever it is.
 *
 * ⚠️ The context is the newest answer's own input: what that turn sent the
 * model. Claude records no window size, so none is guessed (FE-38/D2).
 */
async function claudeFacts(
  file: string,
  { full }: { full: boolean },
): Promise<AgentFacts> {
  let cost: Line | null = null;
  let model: string | null = null;
  let context: number | null = null;
  let recap: AgentFacts["recap"] = null;
  /** The answers newer than `cost`, by message id. */
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
    // ⚠️ Without one, the answers are all there is — and only a read that
    // reached the start has them all: a capped one would undercount.
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
 * A Codex rollout's numbers, from its end (FE-38): the newest `token_count`
 * — the running total for the whole thread, the newest turn's own input as
 * the context, and the window when Codex says it — and the newest
 * `turn_context`'s model and effort. Codex records no cost and no recap.
 *
 * ⚠️ A `token_count` whose `info` is null says nothing: the one before it
 * is the newest that does. `model_context_window` may be missing — then the
 * context is a count with no percentage (FE-38/D2).
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
 * The folder a Claude transcript says it was written in — `undefined` when
 * its head names none.
 *
 * ⚠️ Claude's folder name is lossy (`a_b` and `a-b` are both `a-b`), so a
 * transcript under this folder's name may be another folder's. The listing
 * reads the same line for the same reason.
 */
async function claudeCwd(file: string): Promise<unknown> {
  const head = lines(await readRange(file, 0, CHUNK), { head: true });
  return head.find((line) => typeof line.cwd === "string")?.cwd;
}

/** Codex rollouts found by conversation, kept for the view's next read. */
const codexFiles = new Map<string, string>();

/**
 * The rollout of Codex conversation `id`, if it is one of `folder`'s — by
 * its file's name among the newest rollouts, then by its `session_meta`.
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
 * `agent`'s conversation `id` in `folder`, its numbers read for the agent
 * view and the rail (FE-38).
 *
 * ⚠️ The id is checked again here, and the path built from it inside the
 * CLI's own folder under `home`: Claude's `projects/<folder>/<id>.jsonl`, or
 * a rollout whose own `session_meta` says it is that conversation of this
 * folder.
 */
export async function readAgentFacts(
  home: string,
  folder: string,
  agent: TerminalAgent,
  id: string,
): Promise<AgentFacts> {
  factsRequest(["-", agent, id]);
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

const none = (): AgentUsageTotals => ({
  conversations: 0,
  costUSD: null,
  input: 0,
  output: 0,
});

/**
 * `folder`'s agent usage over the last 7 and 30 days (FE-38/D6), by when
 * each transcript was last written: Claude's cost estimate, both CLIs'
 * tokens, and how many conversations.
 *
 * ⚠️ Every transcript written in the window is read — its end, as far as
 * its newest `cost-state` — so this runs only when Settings asks, never
 * with the listing. A conversation written to in the window counts WHOLE,
 * however long ago it began. A Claude conversation's own totals hold its
 * sub-agents' (FE-38/V5); a Codex thread's spawns are rollouts of their
 * own, counted for their tokens but not as conversations. One whose totals
 * a read cannot reach is left out, and counted in `skipped`.
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
  }));
  const oldest = Math.min(...windows.map((window) => window.from));
  let skipped = 0;
  const add = (
    agent: TerminalAgent,
    at: number,
    facts: AgentFacts,
    conversation: boolean,
  ) => {
    for (const window of windows) {
      if (at < window.from) continue;
      const totals = window[agent];
      if (conversation) totals.conversations++;
      totals.input += facts.tokens?.input ?? 0;
      totals.output += facts.tokens?.output ?? 0;
      if (facts.costUSD !== null)
        totals.costUSD = (totals.costUSD ?? 0) + facts.costUSD;
    }
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

  return {
    windows: windows.map(({ days, claude, codex }) => ({
      days,
      claude,
      codex,
    })),
    skipped,
  };
}
