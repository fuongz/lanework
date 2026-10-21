// What Codex keeps on disk about the account and its goals (FE-41): the usage
// windows its newest turn reported, and the goal each conversation was given.
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a spec
// can drive it under plain Node against a fake Codex home. The goals database
// is Codex's — opened read-only, never written, and a file that cannot be
// read the way this expects is no goals rather than an error.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type CodexGoal,
  type CodexQuota,
  type CodexQuotaWindow,
  type CodexUsage,
  isAgentSessionId,
  isCodexGoalStatus,
} from "../../../shared/terminal";
import { codexRollouts, type Line, lines, readRange } from "./agent-sessions";

/** How much of a rollout's end is read first for the usage it last reported. */
const TAIL = 64 * 1024;
/** How far back at most, when a long tool output came after it. */
const QUOTA_SCAN = 1024 * 1024;
/** The newest-started rollouts weighed by when each was last written. */
const QUOTA_CANDIDATES = 40;
/** Of those, the most read before giving up on one that reported usage. */
const QUOTA_FILES = 5;
/** Goals asked for at once: a rail lists 20 conversations, plus its pinned. */
const GOALS_MAX = 200;
/** What of an objective crosses to the page; Codex's has no limit. */
const OBJECTIVE_MAX = 2000;
/** `goals_<n>.sqlite`: Codex numbers the file by its schema (`_1` today). */
const GOALS_FILE = /^goals_(\d{1,6})\.sqlite$/;

/** Where Codex keeps what this reads (FE-41). */
export interface CodexDirs {
  /** `$CODEX_HOME` or `~/.codex`: its rollouts are under `sessions/`. */
  home: string;
  /** Its databases: `$CODEX_SQLITE_HOME`, else `home`. */
  sqlite: string;
}

function windowOf(value: unknown): CodexQuotaWindow | null {
  if (!value || typeof value !== "object") return null;
  const {
    used_percent: used,
    window_minutes: minutes,
    resets_at: resets,
  } = value as Record<string, unknown>;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (typeof minutes !== "number" || !(minutes > 0)) return null;
  if (typeof resets !== "number" || !Number.isFinite(resets)) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowMinutes: minutes,
    // ⚠️ Unix SECONDS in the rollout.
    resetsAt: resets * 1000,
  };
}

/**
 * The usage the newest `token_count` in `tail` reported (FE-41/D1), or null;
 * `at` stands in for a line with no `timestamp`.
 *
 * ⚠️ Walked back past a report that says nothing: `rate_limits` is null on
 * some, and a `premium` one rides along now and then with neither window —
 * taking either would blank the bar until the next turn.
 */
function codexQuotaOf(tail: Line[], at: string): CodexQuota | null {
  for (let index = tail.length - 1; index >= 0; index--) {
    const line = tail[index] as Line;
    if (line.type !== "event_msg") continue;
    const payload = line.payload as {
      type?: unknown;
      rate_limits?: unknown;
    } | null;
    if (payload?.type !== "token_count") continue;
    const limits = payload.rate_limits as Record<string, unknown> | null;
    if (!limits || typeof limits !== "object") continue;
    if (limits.limit_id != null && limits.limit_id !== "codex") continue;
    const primary = windowOf(limits.primary);
    const secondary = windowOf(limits.secondary);
    if (!primary && !secondary) continue;
    return {
      primary,
      secondary,
      plan:
        typeof limits.plan_type === "string" && limits.plan_type
          ? limits.plan_type
          : null,
      at: typeof line.timestamp === "string" ? line.timestamp : at,
    };
  }
  return null;
}

/**
 * The account's usage as the newest Codex turn on this machine reported it
 * (FE-41/D1): the last `token_count` of the rollout written last.
 *
 * ⚠️ Written last, not started last: a conversation resumed today was begun
 * days ago, and its rollout sorts with that day. Only the newest-started few
 * are weighed — a long-idle one resumed is missed, and the tooltip's "as of"
 * says how old the numbers are.
 */
export async function readCodexQuota(home: string): Promise<CodexQuota | null> {
  const files = (await codexRollouts(join(home, "sessions"))).slice(
    0,
    QUOTA_CANDIDATES,
  );
  const written = await Promise.all(
    files.map(async (file) => ({
      file,
      info: await stat(file).catch(() => null),
    })),
  );
  const newest = written
    .flatMap(({ file, info }) => (info?.isFile() ? [{ file, info }] : []))
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, QUOTA_FILES);
  for (const { file, info } of newest) {
    try {
      // Its end first; further back only when nothing there said.
      for (const span of [TAIL, QUOTA_SCAN]) {
        const start = Math.max(0, info.size - span);
        const tail = lines(await readRange(file, start, info.size - start), {
          head: start === 0,
        });
        const quota = codexQuotaOf(tail, info.mtime.toISOString());
        if (quota) return quota;
        if (start === 0) break;
      }
    } catch {
      // Gone, or being rotated: the next one.
    }
  }
  return null;
}

/** Codex's goals database in `sqlite`: the highest-numbered `goals_*.sqlite`. */
async function codexGoalsFile(sqlite: string): Promise<string | null> {
  let best: { n: number; name: string } | null = null;
  for (const name of await readdir(sqlite).catch(() => [] as string[])) {
    const n = Number(GOALS_FILE.exec(name)?.[1]);
    if (Number.isSafeInteger(n) && (!best || n > best.n)) best = { n, name };
  }
  return best ? join(sqlite, best.name) : null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** One `thread_goals` row, or null for one not shaped as this expects. */
function goalOf(row: Record<string, unknown>): [string, CodexGoal] | null {
  const id = row.thread_id;
  if (!isAgentSessionId(id)) return null;
  if (typeof row.objective !== "string" || !isCodexGoalStatus(row.status))
    return null;
  const used = count(row.tokens_used);
  if (used === null) return null;
  return [
    id,
    {
      objective: row.objective.trim().slice(0, OBJECTIVE_MAX),
      status: row.status,
      tokenBudget: count(row.token_budget),
      tokensUsed: used,
      timeUsedSeconds: count(row.time_used_seconds) ?? 0,
      updatedAt: count(row.updated_at_ms) ?? 0,
    },
  ];
}

/**
 * The goals Codex keeps for the threads `ids` (FE-41/D4), by thread id.
 *
 * ⚠️ Read-only, and empty — never thrown — for a database that is missing,
 * locked, not a database, or of a schema this does not know: the schema is
 * Codex's own and has changed before. Only ids `isAgentSessionId` accepts
 * reach the query, and as bound values, never as SQL.
 *
 * ⚠️ `node:sqlite` is loaded HERE, not at the top: a runtime without it
 * costs the goals, not main's start.
 */
export async function readCodexGoals(
  sqlite: string,
  ids: readonly string[],
): Promise<Record<string, CodexGoal>> {
  const wanted = [...new Set(ids.filter(isAgentSessionId))].slice(0, GOALS_MAX);
  if (wanted.length === 0) return {};
  const file = await codexGoalsFile(sqlite);
  if (!file) return {};
  let db: DatabaseSync | null = null;
  try {
    const driver = await import("node:sqlite");
    db = new driver.DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT thread_id, objective, status, token_budget, tokens_used,
                time_used_seconds, updated_at_ms
           FROM thread_goals
          WHERE thread_id IN (${wanted.map(() => "?").join(", ")})
          ORDER BY thread_id`,
      )
      .all(...wanted);
    const goals: Record<string, CodexGoal> = {};
    for (const row of rows) {
      const goal = goalOf(row);
      if (goal) goals[goal[0]] = goal[1];
    }
    return goals;
  } catch {
    return {};
  } finally {
    try {
      db?.close();
    } catch {
      // Closed already: nothing is held.
    }
  }
}

/** The account's usage and `ids`' goals, read side by side (FE-41). */
export async function readCodexUsage(
  dirs: CodexDirs,
  ids: readonly string[],
): Promise<CodexUsage> {
  const [quota, goals] = await Promise.all([
    readCodexQuota(dirs.home).catch(() => null),
    readCodexGoals(dirs.sqlite, ids),
  ]);
  return { quota, goals };
}
