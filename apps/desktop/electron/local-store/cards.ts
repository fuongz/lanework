import {
  type Card,
  type CardDetail,
  CHECKLIST_SECTIONS,
  CHECKPOINT_MAX_BYTES,
  CHECKPOINTS_KEPT,
  type ChecklistItem,
  type ChecklistItemInput,
  type ChecklistSection,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointRequest,
  type Dispatch,
  type IsoDate,
  type LatestCheckpoint,
  PRIORITIES,
  type Priority,
  STREAM_ISOLATIONS,
  STREAM_ROLES,
  type Stream,
  type StreamInput,
  WORK_ITEM_TYPES,
  type WorkItemType,
} from "@lanework/protocol";
import { type LocalBoardConfig, LocalStoreError } from "./types";

/**
 * Pure shaping: input validation, and rows → `@lanework/protocol` shapes.
 * Nothing here touches SQL, so every rule can be read (and tested) alone.
 */

function invalid(message: string): never {
  throw new LocalStoreError("invalid", message);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ── Scalars ─────────────────────────────────────────────────────────────────

export function checkTitle(title: unknown): string {
  const value = typeof title === "string" ? title.trim() : "";
  if (!value || value.length > 300) invalid("title must be 1-300 characters");
  return value;
}

export function checkType(type: unknown): WorkItemType {
  if (!WORK_ITEM_TYPES.includes(type as WorkItemType))
    invalid(`type must be one of ${WORK_ITEM_TYPES.join(", ")}`);
  return type as WorkItemType;
}

export function checkPriority(priority: unknown): Priority | null {
  if (priority === null || priority === undefined) return null;
  if (!PRIORITIES.includes(priority as Priority))
    invalid(`priority must be one of ${PRIORITIES.join(", ")}`);
  return priority as Priority;
}

export function checkCategory(
  config: LocalBoardConfig,
  key: string | null | undefined,
): string | null {
  if (key === null || key === undefined || key === "") return null;
  if (!config.categories.some((category) => category.key === key))
    invalid(`unknown category "${key}"`);
  return key;
}

export function checkColumn(config: LocalBoardConfig, key: string): string {
  if (!config.columns.some((column) => column.key === key))
    invalid(`unknown column "${key}"`);
  return key;
}

/** The lane a new card lands in: the intake lane, else the first one. */
export function intakeColumn(config: LocalBoardConfig): string {
  const column =
    config.columns.find((entry) => entry.role === "intake") ??
    [...config.columns].sort((a, b) => a.position - b.position)[0];
  if (!column) invalid("the board has no columns");
  return column.key;
}

/** True for a lane whose cards are finished: checkpoints do not survive it. */
export function isClosedColumn(config: LocalBoardConfig, key: string): boolean {
  const role = config.columns.find((column) => column.key === key)?.role;
  return role === "done" || role === "archive";
}

/** Lower-cased, hyphenated, de-duplicated, then held to the board's policy. */
export function normalizeTags(
  config: LocalBoardConfig,
  tags: unknown,
): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) invalid("tags must be a list");
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") invalid("a tag must be text");
    const key = tag.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
    if (key && !out.includes(key)) out.push(key);
  }
  if (config.tags.max > 0 && out.length > config.tags.max)
    invalid(`a card carries at most ${config.tags.max} tags`);
  if (config.tags.allowed.length > 0) {
    const stray = out.filter((tag) => !config.tags.allowed.includes(tag));
    if (stray.length > 0) invalid(`tags not allowed here: ${stray.join(", ")}`);
  }
  return out;
}

// ── Streams ─────────────────────────────────────────────────────────────────

/** `StreamInput[]` → stored `Stream[]`, under the BE-19 rules. */
export function normalizeStreams(input: unknown): Stream[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) invalid("streams must be a list");
  const list = input as StreamInput[];
  const taken = new Set(
    list.map((entry) => entry?.key).filter((key): key is string => !!key),
  );
  let next = 0;
  const mint = () => {
    while (taken.has(`W${next}`)) next += 1;
    const key = `W${next}`;
    taken.add(key);
    return key;
  };
  const streams: Stream[] = list.map((entry, position) => {
    if (!entry || typeof entry !== "object")
      invalid("a stream must be an object");
    const key = entry.key || mint();
    if (!/^W\d{1,3}$/.test(key)) invalid(`stream key "${key}" must be W0…W999`);
    if (!entry.title?.trim()) invalid(`stream ${key} needs a title`);
    if (!entry.goal?.trim()) invalid(`stream ${key} needs a goal`);
    if (!STREAM_ROLES.includes(entry.role))
      invalid(`stream ${key} role must be one of ${STREAM_ROLES.join(", ")}`);
    const isolation = entry.isolation ?? "worktree";
    if (!STREAM_ISOLATIONS.includes(isolation))
      invalid(`stream ${key} isolation must be worktree or shared`);
    if (!Array.isArray(entry.owns) || entry.owns.length === 0)
      invalid(`stream ${key} must own at least one path`);
    for (const path of entry.owns)
      if (typeof path !== "string" || !path || /[*?[\]]/.test(path))
        invalid(`stream ${key} owns "${path}": exact paths only, no globs`);
    return {
      key,
      title: entry.title.trim(),
      goal: entry.goal.trim(),
      role: entry.role,
      owns: [...entry.owns],
      reads: [...(entry.reads ?? [])],
      dependsOn: [...(entry.depends_on ?? [])],
      isolation,
      position,
    };
  });

  const keys = streams.map((stream) => stream.key);
  if (new Set(keys).size !== keys.length) invalid("two streams share a key");
  const owner = new Map<string, string>();
  for (const stream of streams) {
    for (const path of stream.owns) {
      const other = owner.get(path);
      if (other) invalid(`streams ${other} and ${stream.key} both own ${path}`);
      owner.set(path, stream.key);
    }
    for (const dep of stream.dependsOn)
      if (!keys.includes(dep) || dep === stream.key)
        invalid(`stream ${stream.key} depends on unknown stream ${dep}`);
  }
  streamWaves(streams); // throws on a cycle
  return streams;
}

/** Who runs when: every stream whose dependencies are done, wave by wave. */
export function streamWaves(streams: Stream[]): string[][] {
  const done = new Set<string>();
  const waves: string[][] = [];
  const left = [...streams].sort((a, b) => a.position - b.position);
  while (left.length > 0) {
    const wave = left.filter((stream) =>
      stream.dependsOn.every((dep) => done.has(dep)),
    );
    if (wave.length === 0) invalid("stream dependencies form a cycle");
    for (const stream of wave) {
      done.add(stream.key);
      left.splice(left.indexOf(stream), 1);
    }
    waves.push(wave.map((stream) => stream.key));
  }
  return waves;
}

function list(paths: string[]): string {
  return paths.length > 0
    ? paths.map((path) => `- \`${path}\``).join("\n")
    : "- (none)";
}

/** The brief a lead hands each sub-agent verbatim. Null for a card without streams. */
function buildDispatch(
  card: { taskId: string | null; title: string },
  streams: Stream[],
  checklist: ChecklistItem[],
): Dispatch | null {
  if (streams.length === 0) return null;
  const name = card.taskId
    ? `${card.taskId} "${card.title}"`
    : `"${card.title}"`;
  const briefs: Record<string, string> = {};
  for (const stream of streams) {
    const verify = checklist
      .filter((item) => item.section === "verify" && item.stream === stream.key)
      .map((item) => `- ${item.key}: ${item.text}`);
    briefs[stream.key] = [
      `You are sub-agent for stream **${stream.key} (${stream.title})** of card **${name}**.`,
      "",
      "## Goal",
      stream.goal,
      "",
      "## Where you work",
      stream.isolation === "shared"
        ? "In the shared checkout, read-only."
        : "In your own git worktree, which the lead created for this stream. Do not touch any other checkout.",
      "",
      "## You own",
      "Write ONLY inside these paths (a path ending in `/` is a directory):",
      list(stream.owns),
      "",
      "If another file must change, do not change it: say so in your report.",
      "",
      "## Read first",
      list(stream.reads),
      "",
      "## Done means",
      verify.length > 0
        ? verify.join("\n")
        : "- (no verify items tagged to this stream)",
      "",
      "## Rules",
      "- Do not commit, push, or rewrite git history; the lead merges.",
      "- Do not tick checklist boxes; report what you verified and how.",
      "- Do not call the Lanework MCP.",
      "",
      "## Report",
      "Files changed, commands run with pass/fail, and anything the next stream must know.",
    ].join("\n");
  }
  return { waves: streamWaves(streams), briefs };
}

// ── Checklist ───────────────────────────────────────────────────────────────

export const CHECKLIST_TEXT_MAX = 2000;

/**
 * `ChecklistItemInput[]` → stored `ChecklistItem[]`.
 *
 * ⚠️ A sent key is kept; a missing one is minted per section (`D1`, `V1`) and
 * skips every key the list already claims — the board's own rule (see
 * `review-import`). `checked` absent keeps what `previous` says, which is NOT
 * the same as `false`.
 */
export function normalizeChecklist(
  input: unknown,
  options: {
    now: IsoDate;
    previous?: ChecklistItem[];
    streams: Stream[];
  },
): ChecklistItem[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) invalid("checklist must be a list");
  const rows = input as (ChecklistItemInput & { checkedAt?: IsoDate | null })[];
  const before = new Map(
    (options.previous ?? []).map((item) => [item.key, item] as const),
  );
  const taken = new Set(
    rows.map((row) => row?.key).filter((key): key is string => !!key),
  );
  const seen: Record<ChecklistSection, number> = { decisions: 0, verify: 0 };
  const mint = (section: ChecklistSection) => {
    const prefix = section === "verify" ? "V" : "D";
    let key: string;
    do {
      seen[section] += 1;
      key = `${prefix}${seen[section]}`;
    } while (taken.has(key));
    taken.add(key);
    return key;
  };
  const streamKeys = new Set(options.streams.map((stream) => stream.key));

  const items = rows.map((row): ChecklistItem => {
    if (!row || typeof row !== "object")
      invalid("a checklist item must be an object");
    const prev = row.key ? before.get(row.key) : undefined;
    const section = row.section ?? prev?.section ?? "decisions";
    if (!CHECKLIST_SECTIONS.includes(section))
      invalid(`section must be decisions or verify`);
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text || text.length > CHECKLIST_TEXT_MAX)
      invalid(`checklist text must be 1-${CHECKLIST_TEXT_MAX} characters`);
    const checked = row.checked ?? prev?.checked ?? false;
    const checkedAt = checked
      ? (row.checkedAt ??
        (prev?.checked ? prev.checkedAt : null) ??
        options.now)
      : null;
    const stream =
      row.stream === undefined ? (prev?.stream ?? null) : (row.stream ?? null);
    if (stream !== null) {
      if (section !== "verify")
        invalid("only a verify item can carry a stream");
      if (!streamKeys.has(stream)) invalid(`unknown stream ${stream}`);
    }
    return {
      key: row.key || mint(section),
      section,
      text,
      checked,
      checkedAt,
      note: row.note === undefined ? (prev?.note ?? null) : (row.note ?? null),
      group:
        row.group === undefined ? (prev?.group ?? null) : (row.group ?? null),
      stream,
    };
  });
  const keys = items.map((item) => item.key);
  if (new Set(keys).size !== keys.length)
    invalid("two checklist items share a key");
  return items;
}

/** Every verify item still points at a stream the card has. */
export function checkChecklistStreams(
  checklist: ChecklistItem[],
  streams: Stream[],
): void {
  const keys = new Set(streams.map((stream) => stream.key));
  for (const item of checklist)
    if (item.stream && !keys.has(item.stream))
      invalid(`checklist item ${item.key} names unknown stream ${item.stream}`);
}

// ── Checkpoints ─────────────────────────────────────────────────────────────

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

/** Lenient about length, strict about shape and the 16 KiB total — like the cloud. */
export function normalizeCheckpoint(
  request: CheckpointRequest,
): CheckpointContent {
  const summary = clip(request?.summary, 6000);
  if (!summary) invalid("a checkpoint needs a summary");
  const git = request.git
    ? {
        branch: clip(request.git.branch, 200),
        head: clip(request.git.head, 100),
        wipRef: clip(request.git.wipRef, 300),
        wipSha: clip(request.git.wipSha, 100),
        diffStat: clip(request.git.diffStat, 4000),
      }
    : null;
  const content: CheckpointContent = {
    request: clip(request.request, 2000),
    summary,
    nextStep: clip(request.nextStep, 1000),
    files: (request.files ?? [])
      .filter((file): file is string => typeof file === "string" && !!file)
      .slice(-100),
    commands: (request.commands ?? [])
      .filter((entry) => entry && typeof entry.command === "string")
      .slice(-30)
      .map((entry) => ({
        command: entry.command.slice(0, 500),
        ok: typeof entry.ok === "boolean" ? entry.ok : null,
      })),
    host: clip(request.host, 200),
    session: clip(request.session, 200),
    git,
  };
  if (Buffer.byteLength(JSON.stringify(content)) > CHECKPOINT_MAX_BYTES)
    invalid(`a checkpoint weighs at most ${CHECKPOINT_MAX_BYTES} bytes`);
  return content;
}

/** Newest first, at most `CHECKPOINTS_KEPT`. */
export function keepCheckpoints(list: Checkpoint[]): Checkpoint[] {
  return list.slice(0, CHECKPOINTS_KEPT);
}

/** The newest, with `nextStep` carried forward from an older one when it has none. */
export function latestCheckpoint(list: Checkpoint[]): LatestCheckpoint | null {
  const newest = list[0];
  if (!newest) return null;
  if (newest.nextStep) return { ...newest, nextStepFrom: null };
  const older = list.slice(1).find((entry) => entry.nextStep);
  if (!older) return { ...newest, nextStepFrom: null };
  return {
    ...newest,
    nextStep: older.nextStep,
    nextStepFrom: {
      id: older.id,
      agent: older.agent,
      createdAt: older.createdAt,
    },
  };
}

// ── Rows → protocol ─────────────────────────────────────────────────────────

export interface WorkItemRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  task_id: string | null;
  task_seq: number | null;
  category: string | null;
  type: string;
  title: string;
  body: string;
  status: string;
  priority: string | null;
  tags: string;
  checklist: string;
  streams: string;
  checkpoint: string | null;
  sort_key: string;
  revision: number;
  change_seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  cloud_id: string | null;
}

export function toCard(row: WorkItemRow): Card {
  const checklist = parseJson<ChecklistItem[]>(row.checklist, []);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seq: Number(row.change_seq),
    revision: Number(row.revision),
    type: row.type as WorkItemType,
    parentId: row.parent_id,
    columnKey: row.status,
    rank: row.sort_key,
    title: row.title,
    body: row.body,
    priority: (row.priority as Priority | null) ?? null,
    estimate: null,
    categoryKey: row.category,
    taskId: row.task_id,
    tags: parseJson<string[]>(row.tags, []),
    checklistProgress: {
      done: checklist.filter((item) => item.checked).length,
      total: checklist.length,
    },
    streams: parseJson<Stream[]>(row.streams, []),
    metadata: null,
    source: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: null,
    completedAt: null,
    dueAt: null,
    archivedAt: row.deleted_at,
  };
}

export function toCardDetail(row: WorkItemRow): CardDetail {
  const card = toCard(row);
  const checklist = parseJson<ChecklistItem[]>(row.checklist, []);
  return {
    ...card,
    checklist,
    dispatch: buildDispatch(card, card.streams, checklist),
    assignees: { users: [], agents: [] },
    links: [],
    attachments: [],
    subscribers: [],
    subscribed: false,
    favorite: false,
    commentCount: 0,
  };
}
