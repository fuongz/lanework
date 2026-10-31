// One CLI conversation read into Lanework's session store (FE-112): the row
// `upsertSession` takes, its sub-agents, and how far its transcript was read,
// so that the next read starts there instead of at the first byte.
//
// NOTE: Nothing here imports Electron or the store. A Pull runs it in a
// worker thread (`pull-worker.ts`), main runs it on a settled write
// (`pull.ts`), and a spec drives it under plain Node against a fake home.
// The CLIs' files are only ever read.
import type { Stats } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AgentCard,
  type AgentSubagent,
  isAgentSessionIdOf,
} from "../../../shared/terminal";
import type {
  IngestSave,
  IngestState,
  SessionUpsert,
} from "../../session-store/types";
import {
  agentKey,
  codexPrompt,
  codexRole,
  laneworkCard,
} from "../terminal/agent-sessions";
import {
  backgroundCount,
  readTranscriptTasksFrom,
  type TranscriptParseState,
} from "../terminal/background-tasks";
import {
  num,
  opencodeChildren,
  opencodePromptText,
  opencodeTitle,
  opencodeWorking,
  withOpencodeDb,
} from "../terminal/opencode-sessions";
import {
  claudeSubagentGoing,
  claudeWorking,
  codexWorking,
  lastActivity,
  STALE_MS,
  SUBAGENT_STALE_MS,
} from "../transcripts/activity";
import {
  CHUNK,
  CLAUDE_SUBAGENT_FILE,
  claudeProjectDir,
  eachLine,
  type Line,
  lines,
  META_CHUNK,
  readRange,
  tidy,
} from "../transcripts/jsonl";

/** The shape every ingest state is at; bump it when one changes. */
const STATE_VERSION = 1;
/** A conversation's newest sub-agents kept, at most (FE-33/D4). */
export const SUBAGENT_LIMIT = 20;
/** How much of a rollout's first line one step of {@link codexMetaOf} reads. */
const META_STEP = 16 * 1024;
/** The longest OpenCode title, its first prompt included (FE-103). */
const OPENCODE_TITLE_MAX = 200;
/** How many OpenCode conversations one query asks after, at most. */
const OPENCODE_BATCH = 200;

/** One conversation as a read found it: what main writes for it. */
export interface IngestRow {
  /** `agent:id`. */
  key: string;
  /** What `upsertSession` takes but the project, which main names. */
  session: Omit<SessionUpsert, "project">;
  /** How far its transcript was read, for `saveIngest`. */
  ingest: IngestSave;
  /** Its sub-agents, newest first; null leaves the stored ones as they are. */
  subagents: AgentSubagent[] | null;
}

/** What one read of one conversation came to. */
export type IngestOutcome =
  /** Something to write. */
  | { kind: "row"; row: IngestRow }
  /** Nothing new since the stored read, which nothing was read past. */
  | { kind: "unchanged" }
  /**
   * Nothing to list: another folder's, Codex's own helper, one nothing was
   * ever typed in, or gone.
   */
  | { kind: "skip" }
  /** A thread a Codex conversation spawned: one of `root`'s sub-agents. */
  | { kind: "spawned"; root: string; subagent: AgentSubagent };

const SKIP: IngestOutcome = { kind: "skip" };
const UNCHANGED: IngestOutcome = { kind: "unchanged" };

/**
 * What an ingest keeps of a Claude transcript between reads, as JSON.
 *
 * Only what a later line cannot tell again: everything else is read from
 * the transcript's end on each read.
 */
export interface ClaudeIngestState {
  v: typeof STATE_VERSION;
  agent: "claude";
  /** The transcript's own `cwd`, once a line said it. */
  cwd: string | null;
  /** The first prompt somebody typed, tidied. */
  prompt: string | null;
  /** The newest title Claude gave it, as written. */
  aiTitle: string | null;
  /** The newest card a Lanework call named. */
  card: AgentCard | null;
  /** When its first line was written, ISO. */
  createdAt: string | null;
  /** When it last moved, as the last read found it, ISO. */
  updatedAt: string | null;
  /**
   * What it shows can change with the clock alone: a turn open, a task or a
   * sub-agent running. A Pull reads it again though the file did not move.
   */
  live: boolean;
  /** Its background tasks' parse (FE-42), read on from its `offset`. */
  tasks: TranscriptParseState;
}

/** What an ingest keeps of a Codex rollout between reads, as JSON. */
export interface CodexIngestState {
  v: typeof STATE_VERSION;
  agent: "codex";
  /** The first prompt somebody typed, tidied. */
  prompt: string | null;
  /**
   * Its name in `session_index.jsonl` when it was read: a rename is news,
   * though the rollout did not move.
   */
  named: string | null;
  /** The newest card a Lanework call named. */
  card: AgentCard | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** A turn was open: a Pull reads it again though the file did not move. */
  live: boolean;
}

/** What an ingest keeps of an OpenCode conversation between reads. */
export interface OpencodeIngestState {
  v: typeof STATE_VERSION;
  agent: "opencode";
  /** Its `time_updated` when it was read, epoch ms. */
  updated: number;
  /** A turn was open, its own or a sub-agent's. */
  live: boolean;
}

// ── Shared ──────────────────────────────────────────────────────────────────

/** One line of a transcript, parsed; null for one that is cut or not JSON. */
function parseLine(text: string): Line | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Line)
      : null;
  } catch {
    return null;
  }
}

const textOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function isCard(value: unknown): value is AgentCard {
  const card = value as Partial<AgentCard> | null;
  return (
    typeof card === "object" &&
    card !== null &&
    typeof card.boardId === "string" &&
    typeof card.card === "string"
  );
}

/**
 * Whether a raw line may hold a Lanework MCP call: only those are parsed for
 * the card ({@link laneworkCard}).
 *
 * NOTE: Not "mentions Lanework" alone. In a repo of that name every path
 * does, and a transcript runs to tens of MB.
 */
function mayNameCard(text: string): boolean {
  return (
    (text.includes("lanework") || text.includes("Lanework")) &&
    (text.includes("mcp__") ||
      text.includes("McpToolCall") ||
      text.includes('"invocation"'))
  );
}

/**
 * A prompt somebody typed, tidied for a title; null for anything else.
 *
 * NOTE: `agent-sessions.ts` keeps its `typed()` to itself. A Codex
 * `user_message` event is read by that function and nothing else, so it is
 * asked through one: one rule for what a prompt is, not two copies of it.
 */
function typed(text: unknown): string | null {
  return codexPrompt({
    type: "event_msg",
    payload: { type: "user_message", message: text },
  });
}

/** The last whole lines of `file`, of a file `size` bytes long. */
async function tailOf(file: string, size: number): Promise<Line[]> {
  const start = Math.max(0, size - CHUNK);
  return lines(await readRange(file, start, CHUNK), { head: start === 0 });
}

/** An mtime as the store keeps it: whole ms, so it compares equal again. */
const wholeMs = (ms: number) => Math.floor(ms);

// ── Claude ──────────────────────────────────────────────────────────────────

/** Where Claude keeps `folder`'s conversations under `home`. */
export function claudeFolderDir(home: string, folder: string): string {
  return join(home, ".claude", "projects", claudeProjectDir(folder));
}

/**
 * Where Claude conversation `id` of `folder` is kept.
 *
 * @throws when `id` is not a conversation id.
 */
export function claudeTranscriptOf(
  home: string,
  folder: string,
  id: string,
): string {
  if (!isAgentSessionIdOf("claude", id))
    throw new Error("A valid conversation is required");
  return join(claudeFolderDir(home, folder), `${id}.jsonl`);
}

/** The prompt a Claude line holds, if it is one somebody typed. */
function claudePrompt(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return typed(content);
  if (Array.isArray(content))
    for (const part of content as { type?: string; text?: unknown }[])
      if (part?.type === "text") return typed(part.text);
  return null;
}

/**
 * The stored state of `file`, when its read can go on from it.
 *
 * @returns null when the file must be read from its first byte: no state, a
 *   state of another file or version, or a file that shrank (rewritten).
 */
function claudeStateOf(
  prior: IngestState | null,
  file: string,
  size: number,
): ClaudeIngestState | null {
  if (!prior || prior.path !== file) return null;
  if (prior.offset === null || prior.size === null) return null;
  if (prior.size > size || prior.offset > size) return null;
  const state = prior.state as Record<string, unknown> | null;
  if (
    !state ||
    state.v !== STATE_VERSION ||
    state.agent !== "claude" ||
    !textOrNull(state.cwd) ||
    !textOrNull(state.prompt) ||
    !textOrNull(state.aiTitle) ||
    !textOrNull(state.createdAt) ||
    !textOrNull(state.updatedAt) ||
    (state.card !== null && !isCard(state.card)) ||
    typeof state.live !== "boolean" ||
    !state.tasks ||
    typeof state.tasks !== "object"
  )
    return null;
  return state as unknown as ClaudeIngestState;
}

function blankClaude(): Omit<ClaudeIngestState, "tasks"> {
  return {
    v: STATE_VERSION,
    agent: "claude",
    cwd: null,
    prompt: null,
    aiTitle: null,
    card: null,
    createdAt: null,
    updatedAt: null,
    live: false,
  };
}

/**
 * Fold one raw Claude line into `state`.
 *
 * A line is parsed only when it may say something `state` still wants: a
 * transcript runs to tens of MB, and most of it is tool output.
 */
function visitClaude(
  state: Omit<ClaudeIngestState, "tasks">,
  text: string,
): void {
  const wantsCwd = state.cwd === null && text.includes('"cwd"');
  const wantsPrompt = state.prompt === null && text.includes('"type":"user"');
  const titled = text.includes('"ai-title"');
  const card = mayNameCard(text);
  if (!wantsCwd && !wantsPrompt && !titled && !card) return;
  const line = parseLine(text);
  if (!line) return;
  if (wantsCwd && typeof line.cwd === "string") state.cwd = line.cwd;
  if (state.createdAt === null && typeof line.timestamp === "string")
    state.createdAt = line.timestamp;
  if (wantsPrompt) state.prompt = claudePrompt(line);
  // The latest title wins: Claude renames a conversation as it goes.
  if (titled && line.type === "ai-title" && typeof line.aiTitle === "string")
    state.aiTitle = line.aiTitle;
  if (card) state.card = laneworkCard(line) ?? state.card;
}

/**
 * The sub-agents Claude conversation `id` spawned, newest first.
 *
 * NOTE: `agent-sessions.ts`'s own reader, which it keeps to itself: each is
 * `<id>/subagents/agent-<sub>.jsonl` beside the transcript, with a
 * `.meta.json` saying what it was asked. Only a recent one's end is read,
 * for whether it is still going (FE-33).
 *
 * @param dir Claude's folder for the project.
 */
async function claudeSubagents(
  dir: string,
  id: string,
  now: number,
): Promise<AgentSubagent[]> {
  const folder = join(dir, id, "subagents");
  const names = await readdir(folder).catch(() => [] as string[]);
  const files = await Promise.all(
    names.map(async (name) => {
      const sub = CLAUDE_SUBAGENT_FILE.exec(name)?.[1];
      if (!sub) return null;
      const file = join(folder, name);
      const info = await stat(file).catch(() => null);
      return info?.isFile() ? { sub, file, info } : null;
    }),
  );
  const newest = files
    .filter((entry) => entry !== null)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, SUBAGENT_LIMIT);
  return Promise.all(
    newest.map(async ({ sub, file, info }) => {
      const meta = (await readFile(
        join(folder, `agent-${sub}.meta.json`),
        "utf8",
      )
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => null)) as {
        description?: unknown;
        agentType?: unknown;
      } | null;
      const described =
        typeof meta?.description === "string" && meta.description.trim()
          ? tidy(meta.description)
          : null;
      // No meta: what it was asked, its first line.
      const title =
        described ??
        lines(await readRange(file, 0, CHUNK).catch(() => ""), { head: true })
          .filter((line) => line.type === "user")
          .map((line) =>
            typed((line.message as { content?: unknown })?.content),
          )
          .find(Boolean) ??
        "Sub-agent";
      // A background one may go on long after its conversation went quiet.
      const recent = now - info.mtimeMs <= SUBAGENT_STALE_MS;
      const tail = recent ? await tailOf(file, info.size) : [];
      return {
        id: sub,
        title,
        type:
          typeof meta?.agentType === "string" && meta.agentType
            ? meta.agentType
            : null,
        updatedAt: info.mtime.toISOString(),
        working:
          recent &&
          (await claudeSubagentGoing(file, { mtimeMs: info.mtimeMs, tail })),
      };
    }),
  );
}

/**
 * One pass over a Claude transcript: from `kept`'s offset, or from the
 * first byte without it.
 *
 * @returns `foreign` for another folder's transcript.
 */
async function readClaude(
  file: string,
  folder: string,
  kept: ClaudeIngestState | null,
) {
  const next: Omit<ClaudeIngestState, "tasks"> = kept
    ? { ...kept }
    : blankClaude();
  let head: Line[] = [];
  if (!kept) {
    head = lines(await readRange(file, 0, CHUNK), { head: true });
    // NOTE: The folder name is lossy (`a_b` and `a-b` both become `a-b`), so
    // the transcript's own `cwd` has the last word. Told by the head, the
    // rest of another folder's transcript is never read.
    const cwd = head.find((line) => typeof line.cwd === "string")?.cwd;
    if (typeof cwd === "string" && cwd !== folder) return "foreign" as const;
  }
  const read = await readTranscriptTasksFrom(
    file,
    kept?.tasks ?? null,
    (text) => visitClaude(next, text),
  );
  if (next.cwd !== null && next.cwd !== folder) return "foreign" as const;
  return { next, head, ...read };
}

/**
 * One Claude transcript read into a row: only the bytes past the stored
 * offset, its end, and its sub-agents' folder.
 *
 * The title is Claude's newest, else the first prompt; the background
 * tasks (FE-42) go on from the stored parse, so their counts survive a
 * restart without the transcript being read from its first byte again.
 *
 * @param prior What the store has of it (`getIngestState`), or null.
 * @param now Epoch ms, for what is recent.
 */
export async function ingestClaude(
  file: string,
  folder: string,
  prior: IngestState | null,
  now = Date.now(),
): Promise<IngestOutcome> {
  const id = basename(file, ".jsonl");
  if (!isAgentSessionIdOf("claude", id)) return SKIP;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return SKIP;
  const kept = claudeStateOf(prior, file, info.size);
  if (
    kept &&
    !kept.live &&
    prior?.size === info.size &&
    prior.mtime === wholeMs(info.mtimeMs)
  )
    return UNCHANGED;
  let read = await readClaude(file, folder, kept);
  // The stored parse could not be read on (another version's, or the file
  // shrank meanwhile): what the pass found is from the first byte, and so
  // must the rest be.
  if (read !== "foreign" && kept && read.restarted)
    read = await readClaude(file, folder, null);
  if (read === "foreign") return SKIP;
  const { next, head, tasks, state } = read;
  const title = next.aiTitle ? tidy(next.aiTitle) : next.prompt;
  // Nothing was ever asked in it: a CLI opened and closed, nothing to resume.
  if (!title) return SKIP;
  const tail = await tailOf(file, state.size);
  const working = now - state.mtimeMs <= STALE_MS && claudeWorking(tail);
  next.updatedAt =
    lastActivity(tail, "claude") ??
    next.updatedAt ??
    lastActivity(head, "claude") ??
    new Date(state.mtimeMs).toISOString();
  const subagents = await claudeSubagents(dirname(file), id, now);
  const background = backgroundCount(tasks);
  next.live =
    working ||
    background.running > 0 ||
    subagents.some((subagent) => subagent.working);
  const saved: ClaudeIngestState = { ...next, tasks: state };
  return {
    kind: "row",
    row: {
      key: agentKey({ agent: "claude", id }),
      session: {
        agent: "claude",
        id,
        folder,
        cliTitle: title,
        updatedAt: next.updatedAt,
        ...(next.createdAt ? { createdAt: next.createdAt } : {}),
        working,
        // An idle agent is on no card (FE-27/D1).
        card: working ? next.card : null,
        background,
        sourcePath: file,
      },
      ingest: {
        size: state.size,
        mtime: wholeMs(state.mtimeMs),
        offset: state.offset,
        state: saved,
      },
      subagents,
    },
  };
}

// ── Codex ───────────────────────────────────────────────────────────────────

type CodexRole = ReturnType<typeof codexRole>;
type SpawnedRole = Extract<CodexRole, { kind: "spawned" }>;

/**
 * Every Codex rollout under `root`, newest first.
 *
 * The tree is `sessions/YYYY/MM/DD/rollout-….jsonl`, each level sorted.
 * Unlike the rail's listing (`codexRollouts`), every date folder is walked:
 * a Pull reads them all.
 */
export async function allCodexRollouts(root: string): Promise<string[]> {
  const out: string[] = [];
  const down = async (dir: string, depth: number): Promise<void> => {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .sort()
      .reverse();
    for (const name of names) {
      if (depth < 3) await down(join(dir, name), depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
        out.push(join(dir, name));
    }
  };
  await down(root, 0);
  return out;
}

/**
 * A Codex rollout's `session_meta` payload, when the rollout is `folder`'s.
 *
 * Its first line is read step by step up to its end, never past
 * {@link META_CHUNK}: that line carries the whole system prompt, and a Pull
 * asks this of every rollout on the machine. A step that already names
 * another `cwd` ends the read.
 *
 * NOTE: `"cwd":` with its quotes unescaped is a key, never text inside a
 * string, and the payload's own comes before any nested one.
 *
 * @returns
 * - the payload, of a rollout of `folder` with a conversation id;
 * - `false` for another folder's rollout;
 * - `null` when it cannot be told (no `session_meta` written yet, or gone).
 */
export async function codexMetaOf(
  file: string,
  folder: string,
): Promise<Record<string, unknown> | false | null> {
  const ours = Buffer.from(`"cwd":${JSON.stringify(folder)}`);
  let head = Buffer.alloc(0);
  let firstLine: Buffer | null = null;
  try {
    const handle = await open(file, "r");
    try {
      while (head.length < META_CHUNK) {
        const chunk = Buffer.alloc(
          Math.min(META_STEP, META_CHUNK - head.length),
        );
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.length,
          head.length,
        );
        if (bytesRead === 0) break;
        head = Buffer.concat([head, chunk.subarray(0, bytesRead)]);
        const end = head.indexOf(0x0a);
        const first = end === -1 ? head : head.subarray(0, end);
        const kind = first.indexOf('"type":"session_meta"');
        const cwd = first.indexOf('"cwd":');
        if (
          kind !== -1 &&
          cwd > kind &&
          first.length >= cwd + ours.length &&
          !first.subarray(cwd, cwd + ours.length).equals(ours)
        )
          return false;
        if (end !== -1) {
          firstLine = first;
          break;
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  let line = firstLine ? parseLine(firstLine.toString("utf8")) : null;
  if (firstLine && line?.type !== "session_meta")
    // Not first, as Codex writes it: looked for in the head, as
    // `codexRolloutOf` does.
    line =
      lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
        head: true,
      }).find((entry) => entry.type === "session_meta") ?? null;
  const meta = line?.payload as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object") return null;
  if (meta.cwd !== folder || !isAgentSessionIdOf("codex", meta.id))
    return false;
  return meta;
}

/** The stored state of a Codex rollout, when its read can go on from it. */
function codexStateOf(
  prior: IngestState | null,
  file: string,
  size: number,
): CodexIngestState | null {
  if (!prior || prior.path !== file) return null;
  if (prior.offset === null || prior.size === null) return null;
  if (prior.size > size || prior.offset > size) return null;
  const state = prior.state as Record<string, unknown> | null;
  if (
    !state ||
    state.v !== STATE_VERSION ||
    state.agent !== "codex" ||
    !textOrNull(state.prompt) ||
    !textOrNull(state.named) ||
    !textOrNull(state.createdAt) ||
    !textOrNull(state.updatedAt) ||
    (state.card !== null && !isCard(state.card)) ||
    typeof state.live !== "boolean"
  )
    return null;
  return state as unknown as CodexIngestState;
}

/** Fold one raw rollout line into `state`, parsing it only when needed. */
function visitCodex(state: CodexIngestState, text: string): void {
  const wantsPrompt =
    state.prompt === null &&
    (text.includes('"user_message"') || text.includes('"role":"user"'));
  const card = mayNameCard(text);
  if (!wantsPrompt && !card) return;
  const line = parseLine(text);
  if (!line) return;
  if (wantsPrompt) state.prompt = codexPrompt(line);
  if (card) state.card = laneworkCard(line) ?? state.card;
}

/**
 * A spawned Codex thread as its conversation's sub-agent (FE-33).
 *
 * NOTE: As the rail's listing builds it: what it was told is sealed in its
 * spawner's call, so the task it was spawned under names it.
 */
async function codexSpawned(
  file: string,
  meta: Record<string, unknown>,
  role: SpawnedRole,
  info: Stats,
  now: number,
): Promise<AgentSubagent> {
  const recent = now - info.mtimeMs <= STALE_MS;
  const tail = recent ? await tailOf(file, info.size) : [];
  const task =
    role.task ??
    lines(await readRange(file, 0, META_CHUNK), { head: true })
      .map(codexPrompt)
      .find(Boolean) ??
    null;
  return {
    id: meta.id as string,
    title: [role.nickname, task].filter(Boolean).join(": ") || "Sub-agent",
    type: role.role,
    updatedAt: lastActivity(tail, "codex") ?? info.mtime.toISOString(),
    working: recent && codexWorking(tail),
  };
}

/**
 * One Codex rollout read into a row: only the bytes past the stored offset,
 * and its end.
 *
 * The title is its name in `session_index.jsonl`, else its first prompt.
 * Codex keeps no background tasks in its rollout (FE-42/D4).
 *
 * @param prior What the store has of it (`getIngestState`), or null.
 * @param options.names `codexNames(home)`, read once for a whole Pull.
 * @param options.meta Its `session_meta`, when the caller read it already
 *   ({@link codexMetaOf}).
 */
export async function ingestCodex(
  file: string,
  folder: string,
  prior: IngestState | null,
  options: {
    names: ReadonlyMap<string, string>;
    meta?: Record<string, unknown>;
    now?: number;
  },
): Promise<IngestOutcome> {
  const now = options.now ?? Date.now();
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return SKIP;
  const meta = options.meta ?? (await codexMetaOf(file, folder));
  if (!meta || meta.cwd !== folder || !isAgentSessionIdOf("codex", meta.id))
    return SKIP;
  const id = meta.id;
  const role = codexRole(meta);
  // Codex's own helper (a `guardian`, a review): never listed (FE-33/D1).
  if (role.kind === "helper") return SKIP;
  if (role.kind === "spawned")
    return {
      kind: "spawned",
      root: role.root,
      subagent: await codexSpawned(file, meta, role, info, now),
    };
  const named = options.names.get(id) ?? null;
  const kept = codexStateOf(prior, file, info.size);
  if (
    kept &&
    !kept.live &&
    kept.named === named &&
    prior?.size === info.size &&
    prior.mtime === wholeMs(info.mtimeMs)
  )
    return UNCHANGED;
  const next: CodexIngestState = kept
    ? { ...kept, named }
    : {
        v: STATE_VERSION,
        agent: "codex",
        prompt: null,
        named,
        card: null,
        // When the thread began, not when its file was first written.
        createdAt: typeof meta.timestamp === "string" ? meta.timestamp : null,
        updatedAt: null,
        live: false,
      };
  const start = kept && prior?.offset ? prior.offset : 0;
  const end = await eachLine(file, start, (text) => visitCodex(next, text));
  const title = named ? tidy(named) : next.prompt;
  if (!title) return SKIP;
  const size = Math.max(info.size, end);
  const tail = await tailOf(file, size);
  const working = now - info.mtimeMs <= STALE_MS && codexWorking(tail);
  next.updatedAt =
    lastActivity(tail, "codex") ?? next.updatedAt ?? info.mtime.toISOString();
  next.live = working;
  return {
    kind: "row",
    row: {
      key: agentKey({ agent: "codex", id }),
      session: {
        agent: "codex",
        id,
        folder,
        cliTitle: title,
        updatedAt: next.updatedAt,
        ...(next.createdAt ? { createdAt: next.createdAt } : {}),
        working,
        card: working ? next.card : null,
        background: { running: 0, total: 0 },
        sourcePath: file,
      },
      ingest: {
        size,
        mtime: wholeMs(info.mtimeMs),
        offset: end,
        state: next,
      },
      // A conversation's spawned threads are rollouts of their own: a Pull
      // gathers them, a settled write of one adds it (`pull.ts`).
      subagents: null,
    },
  };
}

// ── OpenCode ────────────────────────────────────────────────────────────────

/** One of a folder's top-level OpenCode conversations, from its database. */
export interface OpencodeConversation {
  id: string;
  title: string;
  /** Epoch ms. */
  created: number;
  updated: number;
  /** `time_compacting`: set while OpenCode compacts it. */
  compacting: number | null;
}

/** A first prompt as OpenCode's own title rule has it (FE-103). */
function promptTitle(data: unknown): string | null {
  const text = opencodePromptText(data);
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return (
    (line.length > OPENCODE_TITLE_MAX
      ? `${line.slice(0, OPENCODE_TITLE_MAX - 1)}…`
      : line) || null
  );
}

/**
 * `folder`'s top-level OpenCode conversations, newest first, every one:
 * what a Pull reads (FE-103, FE-104).
 *
 * As the rail lists them: one OpenCode archived (`time_archived`) is left
 * out, and one never typed in has no title and is left out too. Empty,
 * never thrown, for a database that is missing, locked or of a schema this
 * does not know.
 *
 * @param only Just this conversation, when it is one of them.
 */
export function opencodeConversations(
  dataDir: string,
  folder: string,
  only?: string,
): Promise<OpencodeConversation[]> {
  return withOpencodeDb(dataDir, [] as OpencodeConversation[], (db, schema) => {
    const archived = schema.columns.has("time_archived")
      ? "AND s.time_archived IS NULL"
      : "";
    const compacting = schema.columns.has("time_compacting")
      ? "s.time_compacting"
      : "NULL";
    const prompt = schema.v2
      ? `(SELECT m.data FROM session_message m
             WHERE m.session_id = s.id AND m.type = 'user'
             ORDER BY m.seq LIMIT 1)`
      : "NULL";
    const one = only === undefined ? "" : "AND s.id = ?";
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.title AS title, s.time_created AS created,
                  s.time_updated AS updated, ${compacting} AS compacting,
                  ${prompt} AS prompt
             FROM ${schema.table} s
            WHERE s.directory = ? AND s.parent_id IS NULL ${archived} ${one}
            ORDER BY s.time_updated DESC`,
      )
      .all(
        ...(only === undefined ? [folder] : [folder, only]),
      ) as unknown as Record<string, unknown>[];
    const out: OpencodeConversation[] = [];
    for (const row of rows) {
      if (!isAgentSessionIdOf("opencode", row.id)) continue;
      const title = opencodeTitle(row.title) ?? promptTitle(row.prompt);
      // Never typed into: nothing to go back to.
      if (!title) continue;
      const updated = num(row.updated) ?? 0;
      out.push({
        id: row.id,
        title,
        created: num(row.created) ?? updated,
        updated,
        compacting: num(row.compacting),
      });
    }
    return out;
  });
}

/** Whether the store's read of `conversation` is as new as it is. */
export function opencodeUnchanged(
  conversation: OpencodeConversation,
  prior: IngestState | null,
): boolean {
  const state = prior?.state as Partial<OpencodeIngestState> | null;
  return (
    state?.v === STATE_VERSION &&
    state.agent === "opencode" &&
    state.updated === conversation.updated &&
    state.live === false
  );
}

/**
 * `conversations` as rows, each with whether a turn is open and the
 * sessions it spawned, in one open of OpenCode's database.
 *
 * NOTE: No `card` and no background tasks: OpenCode's calls are rows of its
 * database, and it keeps no tasks of the kind Claude does.
 */
export function opencodeRows(
  dataDir: string,
  folder: string,
  conversations: readonly OpencodeConversation[],
): Promise<IngestRow[]> {
  if (conversations.length === 0) return Promise.resolve([]);
  return withOpencodeDb(dataDir, [] as IngestRow[], (db, schema) => {
    const children = new Map<string, AgentSubagent[]>();
    for (let at = 0; at < conversations.length; at += OPENCODE_BATCH) {
      try {
        const ids = conversations
          .slice(at, at + OPENCODE_BATCH)
          .map((conversation) => conversation.id);
        for (const [root, list] of opencodeChildren(db, schema, ids))
          children.set(root, list);
      } catch {
        // A schema without `parent_id` or `agent`: rows without sub-agents.
      }
    }
    return conversations.map((conversation): IngestRow => {
      const working = opencodeWorking(
        db,
        schema,
        conversation.id,
        conversation.updated,
        conversation.compacting,
      );
      const subagents = children.get(conversation.id) ?? [];
      const state: OpencodeIngestState = {
        v: STATE_VERSION,
        agent: "opencode",
        updated: conversation.updated,
        live: working || subagents.some((subagent) => subagent.working),
      };
      return {
        key: agentKey({ agent: "opencode", id: conversation.id }),
        session: {
          agent: "opencode",
          id: conversation.id,
          folder,
          cliTitle: conversation.title,
          updatedAt: new Date(conversation.updated).toISOString(),
          createdAt: new Date(conversation.created).toISOString(),
          working,
          card: null,
          background: { running: 0, total: 0 },
          // One database for every session of the machine: no file is its.
          sourcePath: null,
        },
        // Its position is its `time_updated`; there is no offset to keep.
        ingest: { size: 0, mtime: conversation.updated, offset: 0, state },
        subagents,
      };
    });
  });
}

/**
 * One OpenCode conversation read into a row, unless the store's read is as
 * new as it is.
 *
 * @param prior What the store has of it (`getIngestState`), or null.
 */
export async function ingestOpencode(
  dataDir: string,
  folder: string,
  id: string,
  prior: IngestState | null,
): Promise<IngestOutcome> {
  if (!isAgentSessionIdOf("opencode", id)) return SKIP;
  const [conversation] = await opencodeConversations(dataDir, folder, id);
  if (!conversation) return SKIP;
  if (opencodeUnchanged(conversation, prior)) return UNCHANGED;
  const [row] = await opencodeRows(dataDir, folder, [conversation]);
  return row ? { kind: "row", row } : SKIP;
}
