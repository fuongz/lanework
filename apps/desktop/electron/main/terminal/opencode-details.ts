// One OpenCode conversation's numbers and edited files, for the agent view
// (FE-104): what `agent-facts.ts` and `agent-files.ts` read from a Claude or
// Codex transcript, read here from OpenCode's database. Also a project's
// totals of them, for the usage windows (FE-105/D8).
//
// Read-only, and nothing here imports Electron: main calls it, and a spec can
// drive it against a fake `opencode.db`.
import {
  type AgentFacts,
  type AgentFileOp,
  type AgentFileTouch,
  isAgentSessionIdOf,
} from "../../../shared/terminal";
import {
  num,
  opencodeChildren,
  opencodeSessionIn,
  withOpencodeDb,
} from "./opencode-sessions";

/** Tool parts read for one conversation's edits, its sub-agents' included. */
const FILES_ROWS_MAX = 20_000;

/** A non-blank string, or null. */
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** `opencode-go/glm-5.3`: the model as OpenCode names it, provider first. */
export function opencodeModelName(
  model: Record<string, unknown> | null | undefined,
): string | null {
  const id = str(model?.id) ?? str(model?.modelID);
  if (!id) return null;
  const provider = str(model?.providerID);
  return provider ? `${provider}/${id}` : id;
}

/**
 * Conversation `id`'s numbers (FE-104), when it is one of `folder`'s.
 *
 * - Model and effort: the session row's `model`, its `variant` as the effort
 *   (`default` is none).
 * - Tokens: the row's totals. `input` counts the cache's reads and writes,
 *   as Codex's does, and `cached` is the reads; `output` counts reasoning.
 * - Cost: the row's `cost` in USD, null at 0. OpenCode Go and other
 *   subscriptions are not billed per token, and write 0.
 * - Context: what the newest answer was sent (its input and cache), with no
 *   window: OpenCode does not record one.
 * - Lines: OpenCode's own summary of its edits, when it wrote one.
 *
 * None of it is read from a transcript, so nothing is ever `partial` or
 * `stale`. No duration and no recap.
 *
 * @throws when the conversation is not one of `folder`'s.
 */
export async function opencodeFacts(
  dataDir: string,
  folder: string,
  id: string,
): Promise<AgentFacts> {
  const facts = await withOpencodeDb(
    dataDir,
    null as AgentFacts | null,
    (db, schema) => {
      const row = opencodeSessionIn(db, schema, folder, id);
      if (!row) return null;
      let context: AgentFacts["context"] = null;
      let model = opencodeModelName(row.model);
      if (schema.v2) {
        const last = db
          .prepare(
            `SELECT json_extract(data, '$.tokens') AS tokens,
                    json_extract(data, '$.model') AS model
               FROM session_message
              WHERE session_id = ? AND type = 'assistant'
                AND json_extract(data, '$.tokens') IS NOT NULL
              ORDER BY seq DESC LIMIT 1`,
          )
          .get(id) as { tokens?: unknown; model?: unknown } | undefined;
        try {
          const tokens =
            typeof last?.tokens === "string"
              ? (JSON.parse(last.tokens) as Record<string, unknown>)
              : null;
          const cache = (tokens?.cache ?? {}) as Record<string, unknown>;
          const sent =
            (num(tokens?.input) ?? 0) +
            (num(cache.read) ?? 0) +
            (num(cache.write) ?? 0);
          if (sent > 0) context = { tokens: sent, window: null };
          // The newest answer's model: a session switched mid-way names the
          // one it was started on.
          const answered =
            typeof last?.model === "string"
              ? opencodeModelName(
                  JSON.parse(last.model) as Record<string, unknown>,
                )
              : null;
          model = answered ?? model;
        } catch {
          // Not JSON: no context, and the session's model.
        }
      }
      const t = row.tokens;
      const input = t ? t.input + t.cacheRead + t.cacheWrite : 0;
      const output = t ? t.output + t.reasoning : 0;
      const variant = str(row.model?.variant);
      return {
        agent: "opencode",
        model,
        effort: variant && variant !== "default" ? variant : null,
        costUSD: row.cost !== null && row.cost > 0 ? row.cost : null,
        stale: false,
        tokens:
          t && input + output > 0
            ? { input, output, cached: t.cacheRead }
            : null,
        context,
        lines:
          row.additions !== null || row.deletions !== null
            ? { added: row.additions ?? 0, removed: row.deletions ?? 0 }
            : null,
        duration: null,
        recap: null,
        partial: false,
      } satisfies AgentFacts;
    },
  );
  if (!facts)
    throw new Error("That conversation is not one of this project's.");
  return facts;
}

/** OpenCode's file tools, and the input that names the file. */
const EDIT_TOOLS = new Set(["edit", "write", "multiedit"]);
/** Its patch tools: the files are the patch's `*** … File:` lines. */
const PATCH_TOOLS = new Set(["apply_patch", "patch"]);

/** The files a patch names, and what it did to each. */
function patchedFiles(patch: string): [string, AgentFileOp][] {
  const out: [string, AgentFileOp][] = [];
  for (const match of patch.matchAll(
    /^\*\*\* (Add|Update|Delete) File: (.+)$/gm,
  )) {
    const path = match[2]?.trim();
    if (!path) continue;
    out.push([
      path,
      match[1] === "Add"
        ? "added"
        : match[1] === "Delete"
          ? "deleted"
          : "modified",
    ]);
  }
  return out;
}

/** One file's edits by one session, absolute path to its tally. */
type Edited = Map<string, { op: AgentFileOp; edits: number; lastAt: string }>;

/** One session's edits, and the sub-agent it is (null: the conversation). */
export interface OpencodeEdits {
  via: AgentFileTouch["via"];
  files: Edited;
}

interface ToolRow {
  session: unknown;
  at: unknown;
  name: unknown;
  status: unknown;
  input: unknown;
  metadata: unknown;
  ended: unknown;
}

/**
 * What conversation `id` and its sub-agents edited with OpenCode's file
 * tools (FE-104), one entry per session, the conversation first.
 *
 * `edit`, `write` and `multiedit` name their file (`filePath`, or `path`
 * since OpenCode renamed it); `apply_patch` names its in the patch. A `write`
 * whose metadata says the file did not exist created it. A call that failed
 * edited nothing.
 *
 * NOTE: Schema v2 only: the legacy one keeps tool calls in `part`, and is
 * read as no edits. Like Claude's and Codex's, a file changed through the
 * shell is in no tool call.
 *
 * @returns `partial` when the conversation had more tool calls than one read
 *   takes; the newest are kept.
 * @throws when the conversation is not one of `folder`'s.
 */
export async function opencodeEdits(
  dataDir: string,
  folder: string,
  id: string,
): Promise<{ sources: OpencodeEdits[]; partial: boolean }> {
  const read = await withOpencodeDb(
    dataDir,
    null as { sources: OpencodeEdits[]; partial: boolean } | null,
    (db, schema) => {
      const own = opencodeSessionIn(db, schema, folder, id);
      if (!own || own.parent !== null) return null;
      if (!schema.v2)
        return { sources: [{ via: null, files: new Map() }], partial: false };
      const subs = opencodeChildren(db, schema, [id], 1000).get(id) ?? [];
      const sessions = [id, ...subs.map((sub) => sub.id)];
      const rows = db
        .prepare(
          `SELECT m.session_id AS session, m.time_created AS at,
                  json_extract(c.value, '$.name') AS name,
                  json_extract(c.value, '$.state.status') AS status,
                  json_extract(c.value, '$.state.input') AS input,
                  json_extract(c.value, '$.state.metadata') AS metadata,
                  json_extract(c.value, '$.state.time.end') AS ended
             FROM session_message m, json_each(m.data, '$.content') c
            WHERE m.session_id IN (${sessions.map(() => "?").join(", ")})
              AND m.type = 'assistant'
              AND json_extract(c.value, '$.type') = 'tool'
              AND json_extract(c.value, '$.name') IN
                  ('edit', 'write', 'multiedit', 'apply_patch', 'patch')
            ORDER BY m.time_created DESC
            LIMIT ?`,
        )
        .all(...sessions, FILES_ROWS_MAX + 1) as unknown as ToolRow[];
      const partial = rows.length > FILES_ROWS_MAX;
      const by = new Map<string, Edited>(sessions.map((s) => [s, new Map()]));
      // Oldest first, so the newest edit of a file has the last word.
      for (const row of rows.slice(0, FILES_ROWS_MAX).reverse()) {
        if (row.status !== "completed" || typeof row.name !== "string")
          continue;
        const files = by.get(String(row.session));
        if (!files) continue;
        let input: Record<string, unknown> = {};
        let metadata: Record<string, unknown> = {};
        try {
          input =
            typeof row.input === "string"
              ? (JSON.parse(row.input) as Record<string, unknown>)
              : {};
          metadata =
            typeof row.metadata === "string"
              ? (JSON.parse(row.metadata) as Record<string, unknown>)
              : {};
        } catch {
          continue;
        }
        const at = new Date(num(row.ended) ?? num(row.at) ?? 0).toISOString();
        const touched: [string, AgentFileOp][] = EDIT_TOOLS.has(row.name)
          ? (() => {
              const path = str(input.filePath) ?? str(input.path);
              if (!path) return [];
              return [
                [
                  path,
                  row.name === "write" && metadata.exists === false
                    ? "added"
                    : "modified",
                ],
              ];
            })()
          : PATCH_TOOLS.has(row.name)
            ? patchedFiles(
                str(input.patchText) ??
                  str(input.patch) ??
                  str(input.input) ??
                  "",
              )
            : [];
        for (const [raw, op] of touched) {
          // A relative path is the session's folder's.
          const path = raw.startsWith("/") ? raw : `${folder}/${raw}`;
          const before = files.get(path);
          files.set(path, {
            // Created here, edited after: still a new file.
            op: before?.op === "added" && op !== "deleted" ? "added" : op,
            edits: (before?.edits ?? 0) + 1,
            lastAt: at,
          });
        }
      }
      return {
        sources: sessions.map((session) => ({
          via:
            session === id
              ? null
              : {
                  id: session,
                  type: subs.find((sub) => sub.id === session)?.type ?? null,
                },
          files: by.get(session) ?? new Map(),
        })),
        partial,
      };
    },
  );
  if (!read) throw new Error("That conversation is not one of this project's.");
  return read;
}

/** One OpenCode conversation's totals, its sub-agents' included (FE-105). */
export interface OpencodeUsageRow {
  /** The newest write to the conversation or any session under it, in ms. */
  updated: number;
  /** In USD; null when OpenCode recorded none (a subscription writes 0). */
  costUSD: number | null;
  /** With the cache's reads and writes, as {@link opencodeFacts} counts. */
  input: number;
  /** With reasoning. */
  output: number;
}

/** The columns {@link opencodeUsage} sums; an older OpenCode may lack them. */
const USAGE_COLUMNS = [
  "parent_id",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
];

/**
 * `folder`'s OpenCode conversations written to since `from` (ms), each with
 * the totals of every session under it (FE-105/D8).
 *
 * - A conversation is a top-level session of `folder`. The sessions it
 *   spawned, at any depth, add their tokens and cost to it but are no
 *   conversations of their own, as Codex's spawns.
 * - It falls in a window by the newest `time_updated` of its tree.
 * - Archived ones count: their tokens were spent.
 *
 * NOTE: One read-only query, every value bound. A database that is missing,
 * locked, or lacks the token columns answers none.
 */
export function opencodeUsage(
  dataDir: string,
  folder: string,
  from: number,
): Promise<OpencodeUsageRow[]> {
  return withOpencodeDb(dataDir, [] as OpencodeUsageRow[], (db, schema) => {
    if (!USAGE_COLUMNS.every((column) => schema.columns.has(column))) return [];
    const t = schema.table;
    const rows = db
      .prepare(
        `WITH RECURSIVE tree(id, root) AS (
           SELECT id, id FROM ${t} WHERE directory = ? AND parent_id IS NULL
           UNION ALL
           SELECT s.id, tree.root FROM ${t} s JOIN tree ON s.parent_id = tree.id
         )
         SELECT tree.root AS root, MAX(s.time_updated) AS updated,
                SUM(s.cost) AS cost,
                SUM(s.tokens_input + s.tokens_cache_read
                    + s.tokens_cache_write) AS input,
                SUM(s.tokens_output + s.tokens_reasoning) AS output
           FROM tree JOIN ${t} s ON s.id = tree.id
          GROUP BY tree.root
         HAVING MAX(s.time_updated) >= ?`,
      )
      .all(folder, from) as unknown as Record<string, unknown>[];
    return rows.flatMap((row): OpencodeUsageRow[] => {
      if (!isAgentSessionIdOf("opencode", row.root)) return [];
      const cost = num(row.cost);
      return [
        {
          updated: num(row.updated) ?? 0,
          costUSD: cost !== null && cost > 0 ? cost : null,
          input: num(row.input) ?? 0,
          output: num(row.output) ?? 0,
        },
      ];
    });
  });
}
