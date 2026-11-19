// The kit socket's shadow mode (FE-158): the TS kit answers the caller, and
// `lwk` is asked the same thing beside it; both answers are normalised,
// compared, and one JSON line per call goes to
// `<app home>/logs/kit-shadow.jsonl`.
//
// A line:
//
//   {"t": "2026-11-19T…Z", "method": "search_text", "params": "3f9c…",
//    "equal": false, "tags": ["hidden"], "accepted": true,
//    "diff": {"missing": [".github/x.yml"], "missingCount": 1,
//             "extra": [], "extraCount": 0,
//             "first": {"at": "[\"a.ts\"].lines[0].text", "ts": "…", "lwk": "…"}},
//    "tsMs": 41, "lwkMs": 12}
//
// - `params`: a hash of the method's params and the resolved scope, never
//   the query itself.
// - `missing`: in the TS answer, not lwk's; `extra`: the other way round
//   (file paths, or `harness:sessionId` for sessions). Ten of each at most.
// - `first`: the first field that differs between entries both have, or the
//   first place their order differs where the contract defines an order.
// - `tags: ["order"]`: the entries both have are ranked differently where
//   the contract defines an order (find_files, search_sessions).
// - `tags: ["truncated"]`: list_files cut at its limit, or search_text /
//   search_structural stopped at their file limit, on both sides kept
//   different files (each engine walks in its own order); `accepted` when
//   both kept as many and the files both kept agree.
// - `tags: ["hidden"]`: some of the diff is a hidden path (a segment starting
//   with `.`), which fff lists and lwk skips by design; `accepted` is true
//   when the answers are equal once hidden paths are left out of both.
// - An error on either side is compared by its code (`ts`/`lwk` hold it).
//
// What normalising leaves out: a find_files hit's `score` and `ranges`
// (each engine's own, "only comparable within one answer"), the optional
// `note`, the order of list_files' paths and of search matches' files (the
// contract defines none), and the order of a file's lines (sorted by line).
//
// Never in the way: the caller's answer never waits for lwk, lwk runs with
// its own timeout, at most {@link SHADOW_MAX} run at once (more are logged
// `skipped`), and every failure here is caught and logged, never thrown.
//
// NOTE: No Electron import (the lanework-kit MCP server bundles the socket's
// module graph).
import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { KIT_LIMITS, type KitMethod } from "../kit";
import { appHomeDir } from "./paths";

/** How long lwk may take in shadow before its call is given up. */
const SHADOW_TIMEOUT_MS = 15_000;
/** Shadow lwk calls running at once; more are skipped. */
const SHADOW_MAX = 8;
/** Past this size the log moves to `kit-shadow.1.jsonl` and starts again. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Paths listed per side in a diff. */
const LISTED = 10;
/** The longest value quoted in `first`. */
const QUOTED = 200;

/** How a call ended: its answer, or its error's code and message. */
export type KitOutcome =
  | { ok: true; result: unknown; note?: string; ms: number }
  | { ok: false; code: string; message: string; ms: number };

/** Run `body`, timed, never rejecting. */
export async function timed(
  body: () => Promise<{ result: unknown; note?: string }>,
): Promise<KitOutcome> {
  const started = performance.now();
  try {
    const { result, note } = await body();
    const ms = Math.round(performance.now() - started);
    return note === undefined
      ? { ok: true, result, ms }
      : { ok: true, result, note, ms };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const record = (error ?? {}) as { code?: unknown; message?: unknown };
    return {
      ok: false,
      code: typeof record.code === "string" ? record.code : "internal",
      message:
        typeof record.message === "string" ? record.message : String(error),
      ms,
    };
  }
}

// ─── Normalising ────────────────────────────────────────────────────────────

/** One answer as keyed entries, ready to compare. */
interface Normal {
  entries: [string, unknown][];
  /** Whether the contract defines the entries' order. */
  ordered: boolean;
  /** Answer-level fields beside the entries (list_files' `truncated`). */
  rest: Record<string, unknown>;
  /** The answer was not the shape the contract names. */
  shape?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a tool's list sits when an answer comes wrapped (`--json`). */
const WRAPPED: Record<KitMethod, string | null> = {
  find_files: "files",
  search_text: "matches",
  search_structural: "matches",
  list_files: null,
  search_sessions: "sessions",
};

const sortedLines = (lines: unknown): unknown =>
  Array.isArray(lines)
    ? [...lines].sort(
        (a, b) =>
          Number((a as { line?: unknown })?.line ?? 0) -
          Number((b as { line?: unknown })?.line ?? 0),
      )
    : lines;

function normalise(method: KitMethod, result: unknown): Normal {
  let list = result;
  let shape: string | undefined;
  const wrapped = WRAPPED[method];
  if (wrapped && isObject(result) && Array.isArray(result[wrapped])) {
    list = result[wrapped];
    shape = `wrapped in {${wrapped}}`;
  }
  if (method === "list_files") {
    const files = isObject(result) ? result.files : result;
    if (!Array.isArray(files))
      return { entries: [], ordered: false, rest: { result }, shape: "other" };
    if (!isObject(result)) shape = "a bare list";
    return {
      entries: files.map((path) => [String(path), null]),
      ordered: false,
      rest: { truncated: isObject(result) ? result.truncated : undefined },
      shape,
    };
  }
  if (!Array.isArray(list))
    return { entries: [], ordered: false, rest: { result }, shape: "other" };
  const items = list.filter(isObject);
  switch (method) {
    case "find_files":
      // Score and ranges are each engine's own; the order is the contract's.
      return {
        entries: items.map((hit) => [String(hit.path), null]),
        ordered: true,
        rest: {},
        shape,
      };
    case "search_text":
    case "search_structural":
      // A file's `truncated` marks where the search stopped: the last file
      // each engine kept, which depends on its walk order. Compared as
      // "stopped or not" for the whole answer, not file by file.
      return {
        entries: items.map(({ path, lines, truncated: _cut, ...other }) => [
          String(path),
          { ...other, lines: sortedLines(lines) },
        ]),
        ordered: false,
        rest: { truncated: items.some((item) => item.truncated === true) },
        shape,
      };
    case "search_sessions":
      return {
        entries: items.map(({ harness, sessionId, lines, ...other }) => [
          `${String(harness)}:${String(sessionId)}`,
          { ...other, lines: sortedLines(lines) },
        ]),
        ordered: true,
        rest: {},
        shape,
      };
  }
}

// ─── Comparing ──────────────────────────────────────────────────────────────

export interface ShadowDiff {
  missing: string[];
  missingCount: number;
  extra: string[];
  extraCount: number;
  first?: { at: string; ts?: unknown; lwk?: unknown };
}

export interface ShadowComparison {
  equal: boolean;
  tags?: string[];
  /** Equal once hidden paths are left out of both answers. */
  accepted?: boolean;
  diff?: ShadowDiff;
}

const quote = (value: unknown): unknown => {
  if (value === undefined) return "(none)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text !== undefined && text.length > QUOTED
    ? `${text.slice(0, QUOTED)}…`
    : value;
};

/** The first place `a` and `b` differ, as a path under `at`; null if none. */
function firstDifference(
  a: unknown,
  b: unknown,
  at: string,
): { at: string; ts: unknown; lwk: unknown } | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const found = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const found = firstDifference(a[key], b[key], `${at}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return { at: at || "(answer)", ts: quote(a), lwk: quote(b) };
}

const isHidden = (path: string): boolean =>
  path.split("/").some((segment) => segment.startsWith(".") && segment !== ".");

function diffOf(ts: Normal, lwk: Normal): ShadowDiff | null {
  const tsMap = new Map(ts.entries);
  const lwkMap = new Map(lwk.entries);
  const missing = ts.entries.map(([key]) => key).filter((k) => !lwkMap.has(k));
  const extra = lwk.entries.map(([key]) => key).filter((k) => !tsMap.has(k));
  let first: ShadowDiff["first"];
  if (ts.shape !== lwk.shape)
    first = {
      at: "(shape)",
      ts: ts.shape ?? "contract",
      lwk: lwk.shape ?? "contract",
    };
  if (!first) first = firstDifference(ts.rest, lwk.rest, "") ?? undefined;
  if (!first)
    for (const [key, value] of ts.entries) {
      if (!lwkMap.has(key)) continue;
      const found = firstDifference(
        value,
        lwkMap.get(key),
        `[${JSON.stringify(key)}]`,
      );
      if (found) {
        first = found;
        break;
      }
    }
  if (!first && ts.ordered) {
    const tsOrder = ts.entries.map(([k]) => k).filter((k) => lwkMap.has(k));
    const lwkOrder = lwk.entries.map(([k]) => k).filter((k) => tsMap.has(k));
    const index = tsOrder.findIndex((key, i) => key !== lwkOrder[i]);
    if (index !== -1)
      first = {
        at: `(order)[${index}]`,
        ts: tsOrder[index],
        lwk: lwkOrder[index],
      };
  }
  if (!missing.length && !extra.length && !first) return null;
  return {
    missing: missing.slice(0, LISTED),
    missingCount: missing.length,
    extra: extra.slice(0, LISTED),
    extraCount: extra.length,
    ...(first ? { first } : {}),
  };
}

const withoutHidden = (normal: Normal): Normal => ({
  ...normal,
  entries: normal.entries.filter(([key]) => !isHidden(key)),
  // A cut listing may be cut elsewhere once hidden files are gone.
  rest: {},
});

/** The file limit a call ran with: its own, else the contract's default. */
function limitOf(method: KitMethod, params: Record<string, unknown>): number {
  const { default: fallback, max } = KIT_LIMITS[method];
  return typeof params.limit === "number" && params.limit > 0
    ? Math.min(params.limit, max)
    : fallback;
}

/** Compare two outcomes of the same call, normalised. */
export function compareOutcomes(
  method: KitMethod,
  ts: KitOutcome,
  lwk: KitOutcome,
  limit?: number,
): ShadowComparison {
  if (!ts.ok || !lwk.ok) {
    const tsCode = ts.ok ? "ok" : ts.code;
    // lwk's `cancelled` is the kit's `aborted`: the caller went away.
    const lwkCode = lwk.ok
      ? "ok"
      : lwk.code === "cancelled"
        ? "aborted"
        : lwk.code;
    if (tsCode === lwkCode) return { equal: true };
    return {
      equal: false,
      diff: {
        missing: [],
        missingCount: 0,
        extra: [],
        extraCount: 0,
        first: { at: "(error)", ts: tsCode, lwk: lwkCode },
      },
    };
  }
  const a = normalise(method, ts.result);
  const b = normalise(method, lwk.result);
  const diff = diffOf(a, b);
  if (!diff) return { equal: true };
  // A listing cut at its limit may keep any of the files ("no particular
  // order"): the same count, cut both times, is all that can match.
  if (
    method === "list_files" &&
    a.rest.truncated === true &&
    b.rest.truncated === true
  )
    return {
      equal: false,
      tags: ["truncated"],
      accepted: a.entries.length === b.entries.length && !diff.first,
      diff,
    };
  // A search that stopped at its file limit keeps whichever files its walk
  // reached first: the same count, both times at the limit, is all that
  // can match, and the files both kept must agree.
  if (
    (method === "search_text" || method === "search_structural") &&
    limit !== undefined &&
    a.entries.length >= limit &&
    b.entries.length >= limit
  )
    return {
      equal: false,
      tags: ["truncated"],
      accepted: a.entries.length === b.entries.length && !diff.first,
      diff,
    };
  // Ranked differently: its own tag, so it is read apart from the rest.
  const order = diff.first?.at.startsWith("(order)") ? ["order"] : [];
  if (method === "search_sessions")
    return { equal: false, ...(order.length ? { tags: order } : {}), diff };
  const aKeys = new Set(a.entries.map(([key]) => key));
  const bKeys = new Set(b.entries.map(([key]) => key));
  const hidden =
    a.entries.some(([key]) => !bKeys.has(key) && isHidden(key)) ||
    b.entries.some(([key]) => !aKeys.has(key) && isHidden(key));
  if (!hidden)
    return { equal: false, ...(order.length ? { tags: order } : {}), diff };
  // Without hidden paths on either side. A hidden entry lwk skips lets
  // another one in at the limit, so lwk having more is still accepted;
  // anything missing from it, or any field or order that differs, is not.
  const rest = diffOf(withoutHidden(a), withoutHidden(b));
  const accepted = !rest || (rest.missingCount === 0 && !rest.first);
  return { equal: false, tags: ["hidden", ...order], accepted, diff };
}

// ─── The log ────────────────────────────────────────────────────────────────

/** The shadow log: `<app home>/logs/kit-shadow.jsonl`. */
export function kitShadowLogPath(home = appHomeDir()): string {
  return join(home, "logs", "kit-shadow.jsonl");
}

/** A hash of a call's params and scope, for matching lines, not reading them. */
export function paramsHash(params: Record<string, unknown>): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : isObject(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(stable(params)))
    .digest("hex")
    .slice(0, 16);
}

export interface KitShadowOptions {
  /** {@link kitShadowLogPath} when unset. */
  logFile?: string;
  /** {@link SHADOW_TIMEOUT_MS} when unset. */
  timeoutMs?: number;
  /** {@link LOG_MAX_BYTES} when unset. */
  maxBytes?: number;
}

export interface KitShadow {
  /**
   * Ask lwk the same as a TS call already running, compare, and log; in the
   * background. Never throws, and never holds the TS answer up.
   *
   * @param params The params lwk gets (the scope resolved), hashed for the log.
   * @param ts The TS call's outcome.
   * @param runLwk Calls lwk with the given signal (the shadow's timeout).
   * @param served Which answer the caller got (FE-161): `ts` in `shadow`,
   *   `lwk` in `lwk-shadow`, where the TS call is the one in the background.
   */
  compare: (
    method: KitMethod,
    params: Record<string, unknown>,
    ts: Promise<KitOutcome>,
    runLwk: (
      signal: AbortSignal,
    ) => Promise<{ result: unknown; note?: string }>,
    caller?: AbortSignal,
    served?: "ts" | "lwk",
  ) => void;
  /** Log a call that was not compared, and why. */
  skip: (
    method: KitMethod,
    params: Record<string, unknown>,
    reason: string,
  ) => void;
  /** Lines still being written, done. */
  flush: () => Promise<void>;
}

/** Shadow mode's comparer and log. */
export function createKitShadow(options: KitShadowOptions = {}): KitShadow {
  const file = options.logFile ?? kitShadowLogPath();
  const timeoutMs = options.timeoutMs ?? SHADOW_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  let running = 0;
  let writing: Promise<void> = Promise.resolve();
  let warned = false;

  const append = (record: Record<string, unknown>) => {
    const text = `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`;
    writing = writing
      .then(async () => {
        await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
        const size = await stat(file).then(
          (info) => info.size,
          () => 0,
        );
        if (size + text.length > maxBytes && size > 0)
          await rename(file, file.replace(/\.jsonl$/, ".1.jsonl"));
        await appendFile(file, text, { mode: 0o600 });
      })
      .catch((error: unknown) => {
        if (warned) return;
        warned = true;
        console.warn("[kit-shadow] Unable to write the shadow log", error);
      });
  };

  const compare: KitShadow["compare"] = (
    method,
    params,
    ts,
    runLwk,
    caller,
    served = "ts",
  ) => {
    const hash = paramsHash({ method, ...params });
    if (running >= SHADOW_MAX) {
      append({ method, params: hash, skipped: "busy" });
      return;
    }
    running += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    // lwk-serve's cancel waits a grace for lwk's own answer; this bounds it.
    const lwk = Promise.race([
      timed(() => runLwk(signal)),
      new Promise<KitOutcome>((done) => {
        const timer = setTimeout(
          () =>
            done({
              ok: false,
              code: "timeout",
              message: "Shadow timeout.",
              ms: timeoutMs + 3_000,
            }),
          timeoutMs + 3_000,
        );
        timer.unref?.();
      }),
    ]);
    void Promise.all([ts, lwk])
      .then(([tsOutcome, lwkOutcome]) => {
        const lwkOut: KitOutcome =
          !lwkOutcome.ok && timeout.aborted && !caller?.aborted
            ? { ...lwkOutcome, code: "timeout", message: "Shadow timeout." }
            : lwkOutcome;
        const comparison = compareOutcomes(
          method,
          tsOutcome,
          lwkOut,
          limitOf(method, params),
        );
        append({
          method,
          params: hash,
          served,
          ...comparison,
          tsMs: tsOutcome.ms,
          lwkMs: lwkOut.ms,
          ...(tsOutcome.ok
            ? {}
            : { ts: { error: tsOutcome.code, message: tsOutcome.message } }),
          ...(lwkOut.ok
            ? {}
            : { lwk: { error: lwkOut.code, message: lwkOut.message } }),
          ...(tsOutcome.ok && lwkOut.ok && lwkOut.note
            ? { lwkNote: lwkOut.note }
            : {}),
        });
      })
      .catch((error: unknown) =>
        append({ method, params: hash, failed: String(error) }),
      )
      .finally(() => {
        running -= 1;
      });
  };

  return {
    compare,
    skip: (method, params, reason) =>
      append({
        method,
        params: paramsHash({ method, ...params }),
        skipped: reason,
      }),
    flush: () => writing,
  };
}
