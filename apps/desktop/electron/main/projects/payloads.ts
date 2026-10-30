// The board's IPC payloads off the wire, checked field by field: every
// argument a renderer sends to a project channel is read through here
// before it reaches the board under this machine's credential.
//
// NOTE: Electron-free (FE-82/D1), so these checks can be unit-tested without
// booting the app. Nothing here may import `electron` or a module that does.
import {
  type BoardAttachmentDraft,
  type BoardCardDraft,
  type BoardCardPatch,
  type BoardChecklistDraft,
  type BoardPlacement,
  type BoardQuery,
  CHECKLIST_LIMITS,
  CHECKLIST_SECTIONS,
  DEFAULT_BOARD_QUERY,
} from "../../../shared/projects";
import { arity, id } from "../ipc-args";

/** A tuple of `Count` strings, so `const [a, b] = requireId(args, 2)` is typed. */
type Ids<
  Count extends number,
  Acc extends string[] = [],
> = Acc["length"] extends Count ? Acc : Ids<Count, [...Acc, string]>;

/**
 * A board query off the wire, checked field by field.
 *
 * NOTE: Every value ends up in a URL the service parses, so each is held to a
 * short, non-empty string here; an unknown grouping or a field this app never
 * sends is dropped.
 *
 * @throws When the query or one of its filters is malformed.
 */
export function requireQuery(value: unknown): BoardQuery {
  if (value === undefined) return DEFAULT_BOARD_QUERY;
  if (!value || typeof value !== "object")
    throw new Error("A valid board query is required");
  const raw = value as { groupBy?: unknown; filters?: unknown };
  const groupBy =
    raw.groupBy === "category" || raw.groupBy === "priority"
      ? raw.groupBy
      : "status";
  const filters: BoardQuery["filters"] = {};
  const given =
    raw.filters && typeof raw.filters === "object"
      ? (raw.filters as Record<string, unknown>)
      : {};
  for (const field of ["status", "category", "priority", "tag"] as const) {
    const entry = given[field];
    if (entry === undefined || entry === null || entry === "") continue;
    if (typeof entry !== "string" || entry.length > 40 || !entry.trim())
      throw new Error("A valid board query is required");
    filters[field] = entry;
  }
  return { groupBy, filters };
}

/**
 * Reads an edit off the wire, field by field.
 *
 * NOTE: An allow-list, not a shape check. The renderer is a web origin:
 * whatever it sends reaches the board under this machine's credential, so the
 * set of fields a person can change from a window is decided HERE and nowhere
 * else. An unknown key is a refusal rather than something to drop quietly: a
 * caller sending one has a bug, and ignoring it hides the bug in a write that
 * appears to work.
 *
 * @throws On an unknown field, or a value a field does not take.
 */
export function parsePatch(value: unknown): BoardCardPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("An edit is required");
  const row = value as Record<string, unknown>;
  const allowed = [
    "title",
    "body",
    "priority",
    "tags",
    "categoryKey",
    "assignees",
    "parentId",
    "dueAt",
    "estimate",
    "type",
  ];
  const keys = Object.keys(row);
  if (!keys.length) throw new Error("An edit must change something");
  for (const key of keys)
    if (!allowed.includes(key)) throw new Error(`Cannot change "${key}"`);

  const patch: BoardCardPatch = {};
  if ("title" in row) {
    if (
      typeof row.title !== "string" ||
      !row.title.trim() ||
      row.title.length > 500
    )
      throw new Error("A card needs a title");
    patch.title = row.title.trim();
  }
  if ("body" in row) {
    if (typeof row.body !== "string" || row.body.length > 100_000)
      throw new Error("That description is too long");
    patch.body = row.body;
  }
  if ("priority" in row) {
    if (
      !(
        row.priority === null ||
        row.priority === "low" ||
        row.priority === "medium" ||
        row.priority === "high"
      )
    )
      throw new Error("That priority is not one this board uses");
    patch.priority = row.priority;
  }
  if ("tags" in row) {
    if (
      !Array.isArray(row.tags) ||
      row.tags.length > 20 ||
      !row.tags.every(
        (tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 100,
      )
    )
      throw new Error("Those tags cannot be used");
    patch.tags = row.tags as string[];
  }
  if ("categoryKey" in row) {
    if (
      !(
        row.categoryKey === null ||
        (typeof row.categoryKey === "string" &&
          row.categoryKey.trim().length > 0 &&
          row.categoryKey.length <= 200)
      )
    )
      throw new Error("That category cannot be used");
    patch.categoryKey = row.categoryKey as string | null;
  }
  if ("assignees" in row) {
    // NOTE: BOTH lists are required, even when only one is changing. The
    // service replaces the whole set, so accepting `{ users }` alone would
    // clear every agent assignment as a side effect of naming a person.
    const value = row.assignees;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("An assignment needs users and agents");
    const each = value as Record<string, unknown>;
    const list = (raw: unknown) =>
      Array.isArray(raw) &&
      raw.length <= 50 &&
      raw.every(
        (ref) => typeof ref === "string" && ref.length > 0 && ref.length <= 200,
      )
        ? (raw as string[])
        : null;
    const users = list(each.users);
    const agents = list(each.agents);
    if (!users || !agents) throw new Error("Those assignees cannot be used");
    patch.assignees = { users, agents };
  }
  if ("parentId" in row) {
    if (
      !(
        row.parentId === null ||
        (typeof row.parentId === "string" &&
          row.parentId.trim().length > 0 &&
          row.parentId.length <= 200)
      )
    )
      throw new Error("That parent cannot be used");
    patch.parentId = row.parentId as string | null;
  }
  if ("dueAt" in row) {
    // NOTE: Parsed, not just shape-checked. The service takes an instant, and
    // a string it cannot read comes back as a 400 for a field the user set
    // from a date picker — a bug they can do nothing about.
    if (
      !(
        row.dueAt === null ||
        (typeof row.dueAt === "string" &&
          Number.isFinite(Date.parse(row.dueAt)))
      )
    )
      throw new Error("That due date cannot be used");
    patch.dueAt = row.dueAt as string | null;
  }
  if ("estimate" in row) {
    if (
      !(
        row.estimate === null ||
        (typeof row.estimate === "number" &&
          Number.isInteger(row.estimate) &&
          row.estimate >= 0 &&
          row.estimate <= 1000)
      )
    )
      throw new Error("That estimate cannot be used");
    patch.estimate = row.estimate as number | null;
  }
  if ("type" in row) {
    if (row.type !== "epic" && row.type !== "issue" && row.type !== "task")
      throw new Error("That card type is not one this board uses");
    patch.type = row.type;
  }
  return patch;
}

/**
 * A comment body from the renderer.
 *
 * - Its own check rather than `requireId`, whose message names a project
 *   and a card. This argument is a sentence somebody typed, and "a card is
 *   required" for an empty comment box explains nothing.
 * - The cap mirrors the service's `MAX_COMMENT`. Refusing here is the same
 *   answer, sooner, without a round trip that was never going to succeed.
 */
export function commentBody(args: unknown[], expected: number): string {
  if (args.length !== expected) throw new Error("A comment is required");
  const value = args[expected - 1];
  if (typeof value !== "string" || !value.trim())
    throw new Error("A comment cannot be empty");
  if (value.length > 20_000) throw new Error("That comment is too long");
  return value.trim();
}

/**
 * A file reference on its way to a card.
 *
 * NOTE: A REFERENCE, and this channel never reads it. The service stores
 * metadata and hands the string back untouched, so nothing here opens, stats
 * or resolves what the renderer names. That keeps this from being a channel
 * that reads any file the renderer can spell.
 */
export function parseAttachmentDraft(value: unknown): BoardAttachmentDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A file is required");
  const row = value as Record<string, unknown>;
  const name = row.name;
  const reference = row.reference;
  if (typeof name !== "string" || !name.trim() || name.length > 200)
    throw new Error("That file needs a name");
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.length > 2000
  )
    throw new Error("That file needs a path or a link");
  const sizeBytes = row.sizeBytes;
  if (
    sizeBytes !== undefined &&
    sizeBytes !== null &&
    !(
      typeof sizeBytes === "number" &&
      Number.isInteger(sizeBytes) &&
      sizeBytes >= 0
    )
  )
    throw new Error("That file size cannot be used");
  const mimeType = row.mimeType;
  if (
    mimeType !== undefined &&
    mimeType !== null &&
    !(typeof mimeType === "string" && mimeType.length <= 200)
  )
    throw new Error("That file type cannot be used");
  return {
    name: name.trim(),
    reference: reference.trim(),
    mimeType: (mimeType as string | null | undefined) ?? null,
    sizeBytes: (sizeBytes as number | null | undefined) ?? null,
  };
}

/**
 * A whole checklist on the way to the board.
 *
 * The board's own limits, restated rather than deferred to. The API answers a
 * malformed list with `checklist[7].text is 2311 characters` — a good
 * message, and one that arrives after a round trip that was never going to
 * succeed. Refusing here is the same answer, sooner, and it keeps a renderer
 * bug from looking like a service failure.
 */
export function parseChecklistDraft(value: unknown): BoardChecklistDraft[] {
  if (!Array.isArray(value)) throw new Error("A checklist must be a list");
  if (value.length > CHECKLIST_LIMITS.items)
    throw new Error(
      `A checklist holds at most ${CHECKLIST_LIMITS.items} items`,
    );
  const keys = new Set<string>();
  return value.map((entry, index) => {
    const at = `Checklist item ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${at} is not an item`);
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row))
      if (
        ![
          "key",
          "section",
          "text",
          "checked",
          "note",
          "group",
          "stream",
        ].includes(key)
      )
        throw new Error(`${at} cannot carry "${key}"`);

    if (typeof row.text !== "string" || !row.text.trim())
      throw new Error(`${at} needs text`);
    // Two messages, not one. "needs text" for something 2311 characters long
    // sends the reader looking for an empty field that is not there.
    if (row.text.trim().length > CHECKLIST_LIMITS.text)
      throw new Error(
        `${at} is ${row.text.trim().length} characters; the limit is ${CHECKLIST_LIMITS.text}`,
      );

    const draft: BoardChecklistDraft = { text: row.text.trim() };
    if (row.key !== undefined && row.key !== null) {
      if (
        typeof row.key !== "string" ||
        !row.key.trim() ||
        row.key.length > CHECKLIST_LIMITS.key
      )
        throw new Error(`${at} has a malformed key`);
      // A duplicate key would silently drop one of the two rows on the board.
      if (keys.has(row.key))
        throw new Error(`Two items are keyed "${row.key}"`);
      keys.add(row.key);
      draft.key = row.key;
    }
    if (row.section !== undefined) {
      if (
        !CHECKLIST_SECTIONS.includes(
          row.section as (typeof CHECKLIST_SECTIONS)[number],
        )
      )
        throw new Error(`${at} must be in ${CHECKLIST_SECTIONS.join(" or ")}`);
      draft.section = row.section as BoardChecklistDraft["section"];
    }
    if (row.checked !== undefined) {
      if (typeof row.checked !== "boolean")
        throw new Error(`${at} has an invalid state`);
      draft.checked = row.checked;
    }
    if (row.note !== undefined && row.note !== null) {
      if (
        typeof row.note !== "string" ||
        row.note.length > CHECKLIST_LIMITS.note
      )
        throw new Error(`${at} has an invalid note`);
      draft.note = row.note;
    }
    if (row.group !== undefined && row.group !== null) {
      if (
        typeof row.group !== "string" ||
        !row.group.trim() ||
        row.group.length > CHECKLIST_LIMITS.key
      )
        throw new Error(`${at} has an invalid group`);
      draft.group = row.group;
    }
    // The stream a verify item proves, passed through so a save keeps the
    // tag; the API checks it against the card's streams.
    if (row.stream !== undefined) {
      if (
        row.stream !== null &&
        (typeof row.stream !== "string" || !/^W\d{1,3}$/.test(row.stream))
      )
        throw new Error(`${at} has an invalid stream`);
      draft.stream = row.stream;
    }
    return draft;
  });
}

/**
 * The folders a create call names, resolved to paths.
 *
 * NOTE: An id this run never handed out is a REFUSAL, not a folder to skip.
 * The only way to hold one is to have picked the folder in this app, so an
 * unknown id means the window is asking for something a person never chose.
 * A project quietly created with fewer folders than the dialog listed is
 * worse than one that was not created at all.
 *
 * @param folderFor The chooser's own map from an id it handed out to its
 *   path; passed in so this file stays free of Electron.
 * @throws When an id is malformed or was not handed out by this run.
 */
export function parseFolderIds(
  value: unknown,
  folderFor: (id: string) => string | null | undefined,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("Those source folders cannot be used");
  return value.map((id) => {
    if (typeof id !== "string" || !id.trim())
      throw new Error("Those source folders cannot be used");
    const path = folderFor(id);
    if (!path)
      throw new Error(
        "One of those folders is no longer available. Add it again.",
      );
    return path;
  });
}

/** `{after}` or `{before}` and nothing else — exactly one neighbour. */
export function parsePlacement(value: unknown): BoardPlacement | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("A placement must name one neighbouring card");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 1 || !(keys[0] === "after" || keys[0] === "before"))
    throw new Error("A placement must name one neighbouring card");
  const id = row[keys[0]];
  if (typeof id !== "string" || !id.trim() || id.length > 200)
    throw new Error("A placement must name one neighbouring card");
  return keys[0] === "after" ? { after: id } : { before: id };
}

/**
 * `count` ids off the wire, each 1-200 characters, typed as a tuple of that
 * length.
 *
 * NOTE: `.` and `..` are refused as well as blanks (FE-78/D7). These become
 * path segments of a request sent with this machine's credential, and a URL
 * parser collapses a dot segment: `items/..` would address a different route
 * than the one the handler means.
 */
export function requireId<Count extends number>(
  args: unknown[],
  count: Count,
): Ids<Count> {
  const message = "A valid project and card are required";
  arity(args, count, message);
  for (const arg of args) id(arg, message);
  return args as Ids<Count>;
}

/** The board's own key shape, mirrored from the service's `board-input.ts`. */
export const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A card draft off the wire, checked field by field.
 *
 * - The caps are the SERVICE's own — title 200, body 120000, keys 40, tags
 *   32 × 40. A tampered renderer is what this boundary exists for, and a
 *   limit invented here would either refuse what the board accepts or
 *   forward what it will refuse.
 * - NOTE: Unknown fields are DROPPED rather than forwarded. Only what this
 *   app's own composer can set may reach the board through it: passing the
 *   object straight through would make this channel a way to set `parentId`,
 *   `metadata` or a `source` that no screen in the app can show.
 */
export function parseDraft(value: unknown): BoardCardDraft {
  if (!value || typeof value !== "object")
    throw new Error("A card needs a title");
  const raw = value as Record<string, unknown>;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 200)
    throw new Error("A card needs a title of 1-200 characters");

  const key = (input: unknown, field: string): string | undefined => {
    if (input === undefined || input === null || input === "") return undefined;
    if (typeof input !== "string" || input.length > 40 || !KEY.test(input))
      throw new Error(`That ${field} is not a key this board can use`);
    return input;
  };

  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (body.length > 120_000) throw new Error("That description is too long");

  const priority =
    raw.priority === "low" ||
    raw.priority === "medium" ||
    raw.priority === "high"
      ? raw.priority
      : undefined;
  if (raw.priority !== undefined && raw.priority !== null && !priority)
    throw new Error("Priority must be low, medium or high");

  let tags: string[] | undefined;
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) throw new Error("Tags must be a list");
    tags = raw.tags.map((tag) => {
      if (typeof tag !== "string" || !tag.trim() || tag.length > 40)
        throw new Error("Each tag must be 1-40 characters");
      return tag.trim();
    });
    if (tags.length > 32) throw new Error("That is too many tags");
  }

  return {
    title,
    ...(body ? { body } : {}),
    ...(key(raw.categoryKey, "category") !== undefined
      ? { categoryKey: key(raw.categoryKey, "category") }
      : {}),
    ...(key(raw.columnKey, "status") !== undefined
      ? { columnKey: key(raw.columnKey, "status") }
      : {}),
    ...(priority ? { priority } : {}),
    ...(tags ? { tags } : {}),
  };
}
