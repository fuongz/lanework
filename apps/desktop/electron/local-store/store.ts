import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BoardConfig,
  BoardSummary,
  Card,
  CardDetail,
  ChecklistItem,
  ChecklistItemPatchRequest,
  Checkpoint,
  CheckpointListResponse,
  CheckpointRequest,
  Placement,
  Stream,
} from "@lanework/protocol";
import { appHomeDir } from "../main/paths";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_COLUMNS,
  TAG_MAX,
} from "../main/projects/review-defaults";
import {
  CHECKLIST_TEXT_MAX,
  checkCategory,
  checkChecklistStreams,
  checkColumn,
  checkPriority,
  checkTitle,
  checkType,
  intakeColumn,
  isClosedColumn,
  keepCheckpoints,
  latestCheckpoint,
  normalizeChecklist,
  normalizeCheckpoint,
  normalizeStreams,
  normalizeTags,
  parseJson,
  toCard,
  toCardDetail,
  type WorkItemRow,
} from "./cards";
import { openDatabase, type SqlDatabase, type SqlValue } from "./driver";
import {
  formatTaskId,
  isUuid,
  normalizeRepo,
  RANK_STEP,
  rankString,
  rankValue,
  slugify,
  uuidv7,
} from "./ids";
import { migrate } from "./schema";
import {
  type CheckpointWriter,
  type LocalBoardConfig,
  type LocalProject,
  LocalStoreError,
  type ProjectCreateInput,
  type ProjectUpdateInput,
  type WorkItemCreateInput,
  type WorkItemListQuery,
  type WorkItemUpdateInput,
  type WriteOptions,
} from "./types";

/**
 * The local board's file: `~/.lanew/data.sqlite`.
 *
 * It follows `LANEWORK_HOME` like every other app path (D1a).
 */
const DATA_FILE_NAME = "data.sqlite";

export function localStorePath(): string {
  return join(appHomeDir(), DATA_FILE_NAME);
}

export interface OpenOptions {
  /** Default {@link localStorePath}. `:memory:` works for a throwaway store. */
  path?: string;
  /**
   * How long a writer waits on another's lock before `SQLITE_BUSY`, in ms.
   *
   * Default 5000.
   */
  busyTimeoutMs?: number;
}

/** The board a fresh local project starts with: the cloud defaults. */
function defaultBoardConfig(): LocalBoardConfig {
  return {
    columns: DEFAULT_COLUMNS.map((column, position) => ({
      ...column,
      position,
    })),
    categories: DEFAULT_CATEGORIES.map((category, position) => ({
      ...category,
      position,
    })),
    labels: [],
    tags: { max: TAG_MAX, allowed: [] },
  };
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  repo_url: string | null;
  config: string;
  task_heads: string;
  cloud_id: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toProject(row: ProjectRow): LocalProject {
  const stored = parseJson<Partial<LocalBoardConfig>>(row.config, {});
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repo: row.repo_url,
    config: { ...defaultBoardConfig(), ...stored },
    taskHeads: parseJson<Record<string, number>>(row.task_heads, {}),
    cloudId: row.cloud_id,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function notFound(what: string): never {
  throw new LocalStoreError("not_found", `${what} not found`);
}

function invalid(message: string): never {
  throw new LocalStoreError("invalid", message);
}

/**
 * One connection to the local board.
 *
 * NOTE: Every write runs under `BEGIN IMMEDIATE`, never a deferred
 * transaction. In WAL a deferred transaction that reads and then writes
 * cannot wait out a competing writer: it fails with `SQLITE_BUSY` at once,
 * `busy_timeout` or not. Taking the write lock up front is what lets the app,
 * an MCP server and a hook write the same file at the same time.
 *
 * NOTE: Every write also bumps `meta.change_seq` in the same transaction and
 * stamps it on the rows it touched. `dataVersion()` reads it back, so any
 * process can tell "something changed" with one cheap read, and
 * `listChanges(since)` can say what.
 */
export class LocalStore {
  readonly path: string;
  #db: SqlDatabase | null;
  #depth = 0;
  #seq = 0;

  constructor(db: SqlDatabase, path: string) {
    this.#db = db;
    this.path = path;
  }

  get db(): SqlDatabase {
    if (!this.#db) throw new LocalStoreError("closed", "local store is closed");
    return this.#db;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  #run(sql: string, ...params: SqlValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  /**
   * Run `fn` as one write.
   *
   * `this.#seq` is the change number it stamps. A write inside a write joins
   * the outer one.
   */
  #write<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const row = this.#get<{ value: string }>(
        "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'change_seq' RETURNING value",
      );
      this.#seq = Number(row?.value ?? 0);
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  /**
   * Run several writes as one: all of them land, or none (FE-110).
   *
   * Every store write `fn` makes joins this one, so a throw anywhere rolls
   * back the lot.
   *
   * NOTE: `fn` must be synchronous. An `await` inside would hold the lock
   * across the event loop while the MCP server and the hook wait on it.
   */
  transaction<T>(fn: () => T): T {
    return this.#write(fn);
  }

  /**
   * A number that moves on every committed write.
   *
   * It moves for a write from any connection or process. Poll it; when it
   * differs from the last value, re-read.
   */
  dataVersion(): number {
    const row = this.#get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'change_seq'",
    );
    return Number(row?.value ?? 0);
  }

  #now(): string {
    return new Date().toISOString();
  }

  // ── Projects ────────────────────────────────────────────────────────────

  listProjects(options: { includeDeleted?: boolean } = {}): LocalProject[] {
    const rows = this.#all<ProjectRow>(
      options.includeDeleted
        ? "SELECT * FROM projects ORDER BY created_at, id"
        : "SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at, id",
    );
    return rows.map(toProject);
  }

  /**
   * Find a project by id or slug.
   *
   * @returns Null when there is none, or it is tombstoned.
   */
  getProject(ref: string): LocalProject | null {
    const row = this.#get<ProjectRow>(
      "SELECT * FROM projects WHERE (id = ? OR slug = ?) AND deleted_at IS NULL",
      ref,
      ref,
    );
    return row ? toProject(row) : null;
  }

  #project(ref: string): LocalProject {
    return this.getProject(ref) ?? notFound(`project ${ref}`);
  }

  #uniqueSlug(base: string, except?: string): string {
    let slug = base;
    for (let n = 2; ; n += 1) {
      const clash = this.#get<{ id: string }>(
        "SELECT id FROM projects WHERE slug = ? AND deleted_at IS NULL",
        slug,
      );
      if (!clash || clash.id === except) return slug;
      slug = `${base}-${n}`;
    }
  }

  createProject(input: ProjectCreateInput): LocalProject {
    const name = input.name?.trim();
    if (!name) invalid("a project needs a name");
    const repo = input.repo ? normalizeRepo(input.repo) : null;
    if (input.repo && !repo) invalid(`not a git remote: ${input.repo}`);
    const config = { ...defaultBoardConfig(), ...input.config };
    checkConfig(config);
    return this.#write(() => {
      const id = uuidv7();
      const now = this.#now();
      const slug = this.#uniqueSlug(slugify(input.slug || name));
      if (repo) this.#releaseRepo(repo, now);
      this.#run(
        `INSERT INTO projects (id, slug, name, repo_url, config, task_heads, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
        id,
        slug,
        name,
        repo,
        JSON.stringify(config),
        now,
        now,
      );
      return this.#project(id);
    });
  }

  updateProject(ref: string, input: ProjectUpdateInput): LocalProject {
    return this.#write(() => {
      const current = this.#project(ref);
      const name = input.name === undefined ? current.name : input.name.trim();
      if (!name) invalid("a project needs a name");
      const slug =
        input.slug === undefined
          ? current.slug
          : this.#uniqueSlug(slugify(input.slug), current.id);
      const config = input.config
        ? { ...current.config, ...input.config }
        : current.config;
      checkConfig(config);
      this.#run(
        `UPDATE projects SET name = ?, slug = ?, config = ?, cloud_id = ?, synced_at = ?, updated_at = ?
         WHERE id = ?`,
        name,
        slug,
        JSON.stringify(config),
        input.cloudId === undefined ? current.cloudId : input.cloudId,
        input.syncedAt === undefined ? current.syncedAt : input.syncedAt,
        this.#now(),
        current.id,
      );
      return this.#project(current.id);
    });
  }

  /** Tombstones the project; its cards stay in the file, unreachable. */
  deleteProject(ref: string): void {
    this.#write(() => {
      const current = this.#project(ref);
      const now = this.#now();
      this.#run(
        "UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?",
        now,
        now,
        current.id,
      );
    });
  }

  #releaseRepo(repo: string, now: string): void {
    this.#run(
      "UPDATE projects SET repo_url = NULL, updated_at = ? WHERE repo_url = ? AND deleted_at IS NULL",
      now,
      repo,
    );
  }

  /**
   * Link a repo to one board, like the cloud.
   *
   * A repo another board held moves here.
   *
   * @param remote Any git remote spelling; `null` unlinks.
   */
  linkRepo(ref: string, remote: string | null): LocalProject {
    const repo = remote === null ? null : normalizeRepo(remote);
    if (remote !== null && !repo) invalid(`not a git remote: ${remote}`);
    return this.#write(() => {
      const current = this.#project(ref);
      const now = this.#now();
      if (repo) this.#releaseRepo(repo, now);
      this.#run(
        "UPDATE projects SET repo_url = ?, updated_at = ? WHERE id = ?",
        repo,
        now,
        current.id,
      );
      return this.#project(current.id);
    });
  }

  /**
   * The boards linked to a remote, in any spelling.
   *
   * Act only on exactly one.
   */
  findProjectsByRepo(remote: string): LocalProject[] {
    const repo = normalizeRepo(remote);
    if (!repo) return [];
    return this.#all<ProjectRow>(
      "SELECT * FROM projects WHERE repo_url = ? AND deleted_at IS NULL ORDER BY created_at, id",
      repo,
    ).map(toProject);
  }

  /** The boards as `list_boards` and `GET /v1/boards?repo=` list them. */
  boardSummaries(remote?: string): BoardSummary[] {
    const list =
      remote === undefined
        ? this.listProjects()
        : this.findProjectsByRepo(remote);
    const head = this.dataVersion();
    return list.map((project) => ({
      workspaceId: project.id,
      name: project.name,
      role: "owner",
      changeSeq: head,
      repo: project.repo,
    }));
  }

  /** The board config as the cloud's `GET /config` states it. */
  boardConfig(ref: string): BoardConfig {
    const project = this.#project(ref);
    return {
      workspaceId: project.id,
      role: "owner",
      changeSeq: this.dataVersion(),
      migratedAt: null,
      tags: project.config.tags,
      columns: project.config.columns,
      categories: project.config.categories,
      labels: project.config.labels,
      members: [],
    };
  }

  // ── Task ids ──────────────────────────────────────────────────────────────

  #taskIdTaken(projectId: string, taskId: string): boolean {
    return !!this.#get(
      "SELECT 1 AS hit FROM project_issues WHERE project_id = ? AND task_id = ?",
      projectId,
      taskId,
    );
  }

  #setHead(project: LocalProject, category: string, seq: number): void {
    const heads = { ...project.taskHeads };
    if ((heads[category] ?? 0) >= seq) return;
    heads[category] = seq;
    project.taskHeads = heads;
    this.#run(
      "UPDATE projects SET task_heads = ? WHERE id = ?",
      JSON.stringify(heads),
      project.id,
    );
  }

  /**
   * Mint the next task id of a category (`FE-07`), advancing the head.
   *
   * It must run inside a write. It skips an id a restore already put on the
   * board.
   */
  #mintTaskId(
    project: LocalProject,
    categoryKey: string,
  ): { taskId: string; taskSeq: number } {
    const category = project.config.categories.find(
      (entry) => entry.key === categoryKey,
    );
    if (!category) invalid(`unknown category "${categoryKey}"`);
    let seq = (project.taskHeads[categoryKey] ?? 0) + 1;
    while (this.#taskIdTaken(project.id, formatTaskId(category, seq))) seq += 1;
    this.#setHead(project, categoryKey, seq);
    return { taskId: formatTaskId(category, seq), taskSeq: seq };
  }

  // ── Ranks ─────────────────────────────────────────────────────────────────

  #lane(projectId: string, status: string, except?: string): WorkItemRow[] {
    return this.#all<WorkItemRow>(
      `SELECT * FROM project_issues WHERE project_id = ? AND status = ? AND deleted_at IS NULL AND id != ?
       ORDER BY sort_key, id`,
      projectId,
      status,
      except ?? "",
    );
  }

  /**
   * A rank for `placement` in a lane.
   *
   * Renumbers the lane when the gap is gone.
   */
  #rankFor(
    projectId: string,
    status: string,
    placement: Placement | null | undefined,
    self?: string,
  ): string {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lane = this.#lane(projectId, status, self);
      const values = lane.map((row) => rankValue(row.sort_key));
      let low: number | null;
      let high: number | null;
      const anchor = placement?.after ?? placement?.before ?? null;
      if (anchor) {
        const index = lane.findIndex((row) => row.id === anchor);
        if (index < 0)
          invalid(`placement card ${anchor} is not in lane ${status}`);
        if (placement?.after) {
          low = values[index] as number;
          high = values[index + 1] ?? null;
        } else {
          low = index > 0 ? (values[index - 1] as number) : null;
          high = values[index] as number;
        }
      } else {
        low = values.at(-1) ?? null;
        high = null;
      }
      if (high === null) return rankString((low ?? 0) + RANK_STEP);
      const from = low ?? 0;
      if (high - from > 1) return rankString(Math.floor((from + high) / 2));
      lane.forEach((row, index) => {
        this.#run(
          "UPDATE project_issues SET sort_key = ?, change_seq = ? WHERE id = ?",
          rankString((index + 1) * RANK_STEP),
          this.#seq,
          row.id,
        );
      });
    }
    return invalid("could not place the card");
  }

  // ── Work items ────────────────────────────────────────────────────────────

  #row(id: string): WorkItemRow | undefined {
    return this.#get<WorkItemRow>(
      "SELECT * FROM project_issues WHERE id = ?",
      id,
    );
  }

  /**
   * Find a card by uuid, or by task id (`FE-07`) within `project`.
   *
   * Tombstoned cards are not found unless `includeDeleted`.
   *
   * @throws {@link LocalStoreError} `not_found` when there is no such card.
   */
  #resolve(
    ref: string,
    options: { project?: string; includeDeleted?: boolean } = {},
  ): WorkItemRow {
    let row: WorkItemRow | undefined;
    if (isUuid(ref)) row = this.#row(ref);
    else {
      if (!options.project) invalid(`task id ${ref} needs a project`);
      const project = this.#project(options.project);
      row = this.#get<WorkItemRow>(
        "SELECT * FROM project_issues WHERE project_id = ? AND task_id = ?",
        project.id,
        ref.toUpperCase(),
      );
    }
    if (!row || (row.deleted_at && !options.includeDeleted))
      return notFound(`card ${ref}`);
    if (options.project) {
      const project = this.#project(options.project);
      if (row.project_id !== project.id) return notFound(`card ${ref}`);
    } else if (!this.getProject(row.project_id)) {
      return notFound(`card ${ref}`);
    }
    return row;
  }

  getWorkItem(
    ref: string,
    options: { project?: string; includeDeleted?: boolean } = {},
  ): CardDetail | null {
    try {
      return toCardDetail(this.#resolve(ref, options));
    } catch (error) {
      if (error instanceof LocalStoreError && error.code === "not_found")
        return null;
      throw error;
    }
  }

  /** Ordered by (lane, rank, id), like `GET /items`. */
  listWorkItems(projectRef: string, query: WorkItemListQuery = {}): Card[] {
    const project = this.#project(projectRef);
    const where = ["project_id = ?"];
    const params: SqlValue[] = [project.id];
    if (!query.includeDeleted) where.push("deleted_at IS NULL");
    if (query.column) {
      where.push("status = ?");
      params.push(query.column);
    }
    if (query.category === "none") where.push("category IS NULL");
    else if (query.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (query.parent === "none") where.push("parent_id IS NULL");
    else if (query.parent) {
      where.push("parent_id = ?");
      params.push(query.parent);
    }
    if (query.priority === "none") where.push("priority IS NULL");
    else if (query.priority) {
      where.push("priority = ?");
      params.push(query.priority);
    }
    if (query.tag) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)",
      );
      params.push(query.tag.toLowerCase());
    }
    return this.#all<WorkItemRow>(
      `SELECT * FROM project_issues WHERE ${where.join(" AND ")} ORDER BY status, sort_key, id`,
      ...params,
    ).map(toCard);
  }

  /**
   * The local change feed: cards changed after `since`, tombstones included.
   */
  listChanges(
    projectRef: string,
    since: number,
  ): { head: number; items: Card[] } {
    const project = this.#project(projectRef);
    const head = this.dataVersion();
    const items = this.#all<WorkItemRow>(
      "SELECT * FROM project_issues WHERE project_id = ? AND change_seq > ? ORDER BY change_seq, id",
      project.id,
      since,
    ).map(toCard);
    return { head, items };
  }

  #checkParent(projectId: string, parentId: string | null, self?: string) {
    if (!parentId) return null;
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth += 1) {
      if (cursor === self || depth > 100)
        invalid("a card cannot hang under itself");
      const row = this.#row(cursor);
      if (!row || row.deleted_at || row.project_id !== projectId)
        notFound(`parent card ${cursor}`);
      cursor = row.parent_id;
    }
    return parentId;
  }

  createWorkItem(projectRef: string, input: WorkItemCreateInput): CardDetail {
    return this.#write(() => {
      const project = this.#project(projectRef);
      const { config } = project;
      const now = this.#now();
      const title = checkTitle(input.title);
      const type = checkType(input.type ?? "issue");
      const priority = checkPriority(input.priority);
      const category = checkCategory(config, input.categoryKey);
      const status = input.columnKey
        ? checkColumn(config, input.columnKey)
        : intakeColumn(config);
      const tags = normalizeTags(config, input.tags);
      const streams = normalizeStreams(input.streams);
      const restore = input.restore ?? null;
      const checklist = normalizeChecklist(
        restore?.checklist ?? input.checklist,
        {
          now,
          streams,
        },
      );
      const parentId = this.#checkParent(project.id, input.parentId ?? null);

      let taskId: string | null = null;
      let taskSeq: number | null = null;
      if (restore && (restore.taskId || restore.taskSeq)) {
        if (!restore.taskId || !restore.taskSeq)
          invalid("restore.taskId and restore.taskSeq come together");
        if (!category) invalid("restoring a task id needs a category");
        if (!Number.isInteger(restore.taskSeq) || restore.taskSeq < 1)
          invalid("restore.taskSeq must be a positive integer");
        taskId = restore.taskId.toUpperCase();
        taskSeq = restore.taskSeq;
        if (this.#taskIdTaken(project.id, taskId))
          throw new LocalStoreError("conflict", `task id ${taskId} is taken`);
        this.#setHead(project, category, taskSeq);
      } else if (category) {
        ({ taskId, taskSeq } = this.#mintTaskId(project, category));
      }

      const id = uuidv7();
      const rank = this.#rankFor(project.id, status, input.placement);
      this.#run(
        `INSERT INTO project_issues (id, project_id, parent_id, task_id, task_seq, category, type, title, body,
           status, priority, tags, checklist, streams, checkpoint, sort_key, revision, change_seq,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)`,
        id,
        project.id,
        parentId,
        taskId,
        taskSeq,
        category,
        type,
        title,
        input.body ?? "",
        status,
        priority,
        JSON.stringify(tags),
        JSON.stringify(checklist),
        JSON.stringify(streams),
        rank,
        this.#seq,
        restore?.createdAt ?? now,
        restore?.updatedAt ?? now,
      );
      return toCardDetail(this.#row(id) as WorkItemRow);
    });
  }

  #checkRevision(row: WorkItemRow, options: WriteOptions | undefined) {
    if (
      options?.ifRevision !== undefined &&
      options.ifRevision !== Number(row.revision)
    )
      throw new LocalStoreError(
        "conflict",
        `card is at revision ${row.revision}, not ${options.ifRevision}`,
      );
  }

  /**
   * Apply `sets` to card `id` as one change.
   *
   * It also bumps the revision, and stamps the write's change number and
   * `updated_at`.
   */
  #touch(id: string, sets: string[], params: SqlValue[]): CardDetail {
    this.#run(
      `UPDATE project_issues SET ${[...sets, "revision = revision + 1", "change_seq = ?", "updated_at = ?"].join(", ")}
       WHERE id = ?`,
      ...params,
      this.#seq,
      this.#now(),
      id,
    );
    return toCardDetail(this.#row(id) as WorkItemRow);
  }

  updateWorkItem(
    ref: string,
    input: WorkItemUpdateInput,
    options: WriteOptions & { project?: string } = {},
  ): CardDetail {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const project = this.#project(row.project_id);
      const { config } = project;
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const set = (column: string, value: SqlValue) => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (input.title !== undefined) set("title", checkTitle(input.title));
      if (input.type !== undefined) set("type", checkType(input.type));
      if (input.body !== undefined) set("body", input.body ?? "");
      if (input.priority !== undefined)
        set("priority", checkPriority(input.priority));
      if (input.tags !== undefined)
        set("tags", JSON.stringify(normalizeTags(config, input.tags)));
      if (input.parentId !== undefined)
        set("parent_id", this.#checkParent(project.id, input.parentId, row.id));
      if (input.cloudId !== undefined) set("cloud_id", input.cloudId);
      if (input.categoryKey !== undefined) {
        const category = checkCategory(config, input.categoryKey);
        set("category", category);
        // A card keeps the id it was born with; one that never had one gets
        // it now.
        if (category && !row.task_id) {
          const minted = this.#mintTaskId(project, category);
          set("task_id", minted.taskId);
          set("task_seq", minted.taskSeq);
        }
      }
      const streams =
        input.streams !== undefined
          ? normalizeStreams(input.streams)
          : parseJson<Stream[]>(row.streams, []);
      if (input.streams !== undefined) set("streams", JSON.stringify(streams));
      const previous = parseJson<ChecklistItem[]>(row.checklist, []);
      const checklist =
        input.checklist !== undefined
          ? normalizeChecklist(input.checklist, {
              now: this.#now(),
              previous,
              streams,
            })
          : previous;
      checkChecklistStreams(checklist, streams);
      if (input.checklist !== undefined)
        set("checklist", JSON.stringify(checklist));
      return this.#touch(row.id, sets, params);
    });
  }

  /** Tombstones a card (`deleted_at`) and clears its checkpoints. */
  deleteWorkItem(
    ref: string,
    options: WriteOptions & { project?: string } = {},
  ): CardDetail {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      return this.#touch(
        row.id,
        ["deleted_at = ?", "checkpoint = NULL"],
        [this.#now()],
      );
    });
  }

  /** Brings a tombstoned card back, at the bottom of its lane. */
  restoreWorkItem(ref: string, options: { project?: string } = {}): CardDetail {
    return this.#write(() => {
      const row = this.#resolve(ref, { ...options, includeDeleted: true });
      if (!row.deleted_at) return toCardDetail(row);
      const rank = this.#rankFor(row.project_id, row.status, null, row.id);
      return this.#touch(row.id, ["deleted_at = NULL", "sort_key = ?"], [rank]);
    });
  }

  /**
   * Move a card to a lane, or to a place in it, or both.
   *
   * Landing in a `done` or `archive` lane clears its checkpoints, as on the
   * cloud.
   */
  setStatus(
    ref: string,
    columnKey: string | null,
    options: WriteOptions & {
      project?: string;
      placement?: Placement | null;
    } = {},
  ): CardDetail {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const { config } = this.#project(row.project_id);
      const status = columnKey ? checkColumn(config, columnKey) : row.status;
      if (status === row.status && !options.placement) return toCardDetail(row);
      const rank = this.#rankFor(
        row.project_id,
        status,
        options.placement,
        row.id,
      );
      const sets = ["status = ?", "sort_key = ?"];
      if (isClosedColumn(config, status)) sets.push("checkpoint = NULL");
      return this.#touch(row.id, sets, [status, rank]);
    });
  }

  /** `PATCH …/checklist/:key`: tick, untick, note, retext, retag. */
  toggleChecklistItem(
    ref: string,
    key: string,
    patch: ChecklistItemPatchRequest,
    options: WriteOptions & { project?: string } = {},
  ): CardDetail {
    return this.#write(() => {
      const row = this.#resolve(ref, options);
      this.#checkRevision(row, options);
      const checklist = parseJson<ChecklistItem[]>(row.checklist, []);
      const item = checklist.find((entry) => entry.key === key);
      if (!item) notFound(`checklist item ${key}`);
      if (patch.checked !== undefined && patch.checked !== item.checked) {
        item.checked = patch.checked;
        item.checkedAt = patch.checked ? this.#now() : null;
      }
      if (patch.note !== undefined) item.note = patch.note || null;
      if (patch.text !== undefined) {
        const text = patch.text.trim();
        if (!text || text.length > CHECKLIST_TEXT_MAX)
          invalid(`checklist text must be 1-${CHECKLIST_TEXT_MAX} characters`);
        item.text = text;
      }
      if (patch.stream !== undefined) {
        if (patch.stream !== null && item.section !== "verify")
          invalid("only a verify item can carry a stream");
        item.stream = patch.stream;
        checkChecklistStreams(checklist, parseJson<Stream[]>(row.streams, []));
      }
      return this.#touch(
        row.id,
        ["checklist = ?"],
        [JSON.stringify(checklist)],
      );
    });
  }

  // ── Checkpoints ───────────────────────────────────────────────────────────

  /**
   * Add a checkpoint, keeping the newest `CHECKPOINTS_KEPT`.
   *
   * @throws {@link LocalStoreError} `conflict` on a card in a `done` or
   *   `archive` lane; `invalid` on a checkpoint it refuses.
   */
  addCheckpoint(
    ref: string,
    request: CheckpointRequest,
    writer: CheckpointWriter & { project?: string } = {},
  ): Checkpoint {
    const content = normalizeCheckpoint(request);
    return this.#write(() => {
      const row = this.#resolve(ref, { project: writer.project });
      const { config } = this.#project(row.project_id);
      if (isClosedColumn(config, row.status))
        throw new LocalStoreError(
          "conflict",
          "a finished or archived card takes no checkpoints",
        );
      const checkpoint: Checkpoint = {
        ...content,
        id: uuidv7(),
        agent: writer.agent || "agent",
        userId: writer.userId || "local",
        machineId: writer.machineId ?? null,
        createdAt: this.#now(),
      };
      const list = keepCheckpoints([
        checkpoint,
        ...parseJson<Checkpoint[]>(row.checkpoint, []),
      ]);
      // NOTE: Not `#touch`: a checkpoint is not an edit. It bumps neither the
      // revision an `If-Match` is checked against nor `updated_at`.
      this.#run(
        "UPDATE project_issues SET checkpoint = ?, change_seq = ? WHERE id = ?",
        JSON.stringify(list),
        this.#seq,
        row.id,
      );
      return checkpoint;
    });
  }

  /** Newest first, with the carried-forward `latest`. */
  listCheckpoints(
    ref: string,
    options: { project?: string } = {},
  ): CheckpointListResponse {
    const row = this.#resolve(ref, options);
    const checkpoints = parseJson<Checkpoint[]>(row.checkpoint, []);
    return { checkpoints, latest: latestCheckpoint(checkpoints) };
  }
}

function checkConfig(config: LocalBoardConfig): void {
  if (!Array.isArray(config.columns) || config.columns.length === 0)
    invalid("a board needs at least one column");
  const columnKeys = config.columns.map((column) => column.key);
  if (new Set(columnKeys).size !== columnKeys.length)
    invalid("two columns share a key");
  const categoryKeys = config.categories.map((category) => category.key);
  if (new Set(categoryKeys).size !== categoryKeys.length)
    invalid("two categories share a key");
  const prefixes = config.categories.map((category) => category.prefix);
  if (new Set(prefixes).size !== prefixes.length)
    invalid("two categories share a task-id prefix");
}

/**
 * Open the local board file.
 *
 * It creates the file and its folder when absent, and opens it in WAL mode
 * with a busy timeout, migrated to the current schema.
 *
 * NOTE (FE-78/D8): A new folder is created 0700 and a new file 0600, so other
 * users on the machine cannot read the boards. SQLite gives the WAL and
 * shared-memory files the main file's mode. An existing folder or file keeps
 * the mode it has.
 */
export function openLocalStore(options: OpenOptions = {}): LocalStore {
  const path = options.path ?? localStorePath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // An empty file is a valid empty database; creating it here is what lets
    // the mode be set before SQLite writes anything into it.
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  }
  const db = openDatabase(path);
  try {
    // busy_timeout first: switching to WAL itself needs a lock another
    // process may be holding at this moment.
    db.exec(
      `PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`,
    );
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new LocalStore(db, path);
}
