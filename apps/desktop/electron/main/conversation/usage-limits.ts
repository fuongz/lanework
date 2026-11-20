// Usage limits: what main does when an agent's account runs out.
//
// - Detect: every engine reports how each turn ended (`TurnOutcome`). A
//   failed one is read for a usage limit: the CLI's structured fields first
//   (Claude's `rate_limit_event` and `rate_limit` error, Codex's
//   `usageLimitExceeded`, OpenCode's 429), its words ("You've hit your
//   5-hour limit") only as a fallback.
// - State: one `UsageLimit` per agent and scope, until its `resetsAt` passes
//   or a turn under it goes through again.
// - Scope: a limit is the whole account's, or one model family's (Claude's
//   weekly Opus or Sonnet cap). A scoped one stops, and is cleared by, only
//   turns on that family.
// - Stop: every running turn under the limit is stopped the way the Stop
//   button stops it, and the conversations are remembered.
// - Auto-continue: an opted-in, stopped conversation is sent "Continue where
//   you left off." through the normal send path once the limit resets.
// - Kept: limits, stops and opt-ins are written to a file, so a continue
//   planned before a quit still goes after the next start.
//
// Nothing here imports Electron: main hands in how to stop, send, read the
// usage windows and tell the pages.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AUTO_CONTINUE_TEXT,
  type ConversationAgent,
  inScope,
  type UsageLimit,
  type UsageLimitStop,
  type UsageLimitsState,
  type UsageLimitWindow,
} from "../../../shared/conversation";

/** How long after the reset the continue goes: the CLI's clock may lag. */
export const CONTINUE_MARGIN_MS = 30_000;
/** How long the usage readers are waited on for a reset time. */
const READERS_TIMEOUT_MS = 8_000;
/** The most opt-ins kept: one per conversation the person ever ticked. */
const OPT_IN_MAX = 256;
/** `setTimeout` fires at once past this (2^31 - 1 ms, about 24.8 days). */
const TIMER_MAX_MS = 2_147_483_647;

/** What a failed turn said, as its engine read it. */
export interface TurnFailure {
  /** The CLI's words for the failure. */
  text: string;
  /**
   * The CLI's structured fields say this was a usage limit (Claude's
   * `rate_limit_event` rejected, Codex's `usageLimitExceeded`).
   */
  limited?: boolean;
  /**
   * A structured field hints at one but cannot tell a usage limit from a
   * passing rate limit (Claude's `rate_limit` error alone, OpenCode's 429):
   * the words or a usage window at its cap have to agree.
   */
  throttled?: boolean;
  /** The window the structured fields named. */
  window?: UsageLimitWindow | null;
  /** When it resets, as the structured fields said; epoch ms. */
  resetsAt?: number | null;
  /**
   * The model family the limit caps alone (`opus`, `sonnet`), when the CLI
   * said so; null or absent for the whole account.
   */
  scope?: string | null;
}

/** How a turn ended, told by every engine at every turn's end. */
export interface TurnOutcome {
  agent: ConversationAgent;
  project: string;
  /** Null for a new Codex or OpenCode conversation its CLI has not named. */
  conversation: string | null;
  /** The model the turn ran on, when known. */
  model?: string | null;
  /** Null when the turn went through, or was stopped. */
  failure: TurnFailure | null;
}

/** One usage window as the usage readers last knew it. */
export interface UsageWindowReading {
  /** 300 is the 5-hour one, 10080 the week, 43200 the month. */
  windowMinutes: number;
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms; null when the reader does not say. */
  resetsAt: number | null;
  /** The reader says this window refuses turns now. */
  limited: boolean;
}

/** The window a length in minutes is; `unknown` for one not offered. */
export function windowOfMinutes(minutes: number): UsageLimitWindow {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "weekly";
  if (minutes >= 40000 && minutes <= 45000) return "monthly";
  return "unknown";
}

/** The window Claude's `rateLimitType` names. */
export function claudeWindowOf(type: unknown): UsageLimitWindow | null {
  if (typeof type !== "string") return null;
  if (type === "five_hour") return "5-hour";
  if (type.startsWith("seven_day")) return "weekly";
  return null;
}

/**
 * The model family Claude's `rateLimitType` caps alone (`seven_day_opus` is
 * `opus`), or null for a window of the whole account.
 */
export function claudeScopeOf(type: unknown): string | null {
  if (typeof type !== "string") return null;
  const family = /^seven_day_([a-z]+)$/.exec(type)?.[1];
  return family ?? null;
}

/**
 * Of the windows given, the one that refuses turns now: at its cap, or said
 * to be limited. When several are, the one that resets last, since turns
 * run again only once every one has.
 */
export function maxedWindow(
  windows: readonly UsageWindowReading[],
): UsageWindowReading | null {
  const maxed = windows.filter(
    (window) => window.limited || window.usedPercent >= 100,
  );
  if (!maxed.length) return null;
  return maxed.reduce((last, window) =>
    (window.resetsAt ?? 0) > (last.resetsAt ?? 0) ? window : last,
  );
}

// ─── Reading the words ──────────────────────────────────────────────────────

/**
 * What a usage limit reads as. Only as a fallback: an agent's own reply may
 * quote these words, so they are read only from a turn that failed.
 */
const LIMIT_WORDS = [
  /\byou['’]ve (?:hit|reached) your\b[^.\n]{0,40}\blimit\b/i,
  /\busage limit\b[^.\n]{0,20}\b(?:reached|exceeded|hit)\b/i,
  /\b(?:5[- ]hour|five[- ]hour|session|weekly|monthly) (?:usage )?limit (?:reached|exceeded|hit)\b/i,
  // Claude's older wording carried the reset as epoch seconds.
  /\blimit reached\|\d{10}\b/i,
];

/** Whether `text` reads as a usage limit. */
export function readsAsUsageLimit(text: string): boolean {
  return LIMIT_WORDS.some((pattern) => pattern.test(text));
}

/** The window `text` names, read before any reset clause. */
export function windowOfText(text: string): UsageLimitWindow {
  // "resets Oct 9" or "try again in 2 days" says nothing of the window.
  const head = text.split(/\b(?:resets?|try again|available again)\b/i)[0];
  if (/\b(?:5[- ]?hour|five[- ]hour|session)\b/i.test(head)) return "5-hour";
  if (/\b(?:weekly|7[- ]day|seven[- ]day|week)\b/i.test(head)) return "weekly";
  if (/\bmonth(?:ly)?\b/i.test(head)) return "monthly";
  return "unknown";
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * How far `zone` is ahead of UTC at `at`, in ms.
 *
 * @throws When `zone` is not a time zone Intl knows.
 */
function zoneOffset(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/** The calendar date `zone` (local when null) is on at `at`. */
function dateIn(
  at: number,
  zone: string | null,
): { year: number; month: number; day: number } {
  if (!zone) {
    const date = new Date(at);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
    };
  }
  const date = new Date(at + zoneOffset(at, zone));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

/** The instant a wall-clock time in `zone` (local when null) is. */
function wallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string | null,
): number {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  // Asked twice: the offset at the guess may differ from the one at the
  // answer across a DST change.
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}

/** A zone Intl knows, else null (local time is read instead). */
function knownZone(value: string | undefined): string | null {
  if (!value) return null;
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/**
 * When the words say the limit resets, epoch ms; null when they do not, or
 * not in a way read here.
 *
 * Reads, in order: Claude's old `limit reached|<epoch>`, an ISO time,
 * "try again in 2 hours 5 minutes", and a clock time with an optional date
 * and zone: "resets 3pm (America/Los_Angeles)", "resets Oct 9, 10am",
 * "try again at Nov 21st, 2026 3:05 PM".
 */
export function resetOfText(text: string, now = Date.now()): number | null {
  const epoch = /\blimit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;

  const iso =
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/.exec(
      text,
    );
  if (iso) {
    const at = Date.parse(iso[0]);
    if (Number.isFinite(at)) return at;
  }

  const relative =
    /\b(?:try again|resets?|available again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i.exec(
      text,
    );
  if (relative?.[1]) {
    let ms = 0;
    for (const [, amount, unit] of relative[1].matchAll(
      /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi,
    )) {
      const n = Number(amount);
      const u = (unit ?? "").toLowerCase();
      if (u.startsWith("d")) ms += n * 86_400_000;
      else if (u.startsWith("h")) ms += n * 3_600_000;
      else ms += n * 60_000;
    }
    if (ms > 0) return now + ms;
  }

  const clock =
    /\b(?:resets?|try again|available again)(?:\s+(?:at|on))?\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?(?:m\.?)?(?:\s*\(([^)]{1,64})\))?/i.exec(
      text,
    );
  if (!clock) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, half, zoneText] =
    clock;
  // A bare number ("resets in 5") is no clock time: it needs am/pm or minutes.
  if (!half && minuteText === undefined) return null;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const zone = knownZone(zoneText);
  const today = dateIn(now, zone);
  if (monthName && dayText) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const year = yearText ? Number(yearText) : today.year;
    let at = wallTime(year, month, Number(dayText), hour, minute, zone);
    // "Jan 2" read on Dec 30 is next year's.
    if (!yearText && at < now - 86_400_000)
      at = wallTime(year + 1, month, Number(dayText), hour, minute, zone);
    return at;
  }
  const at = wallTime(today.year, today.month, today.day, hour, minute, zone);
  // A clock time already past today is tomorrow's.
  return at <= now - 60_000
    ? wallTime(today.year, today.month, today.day + 1, hour, minute, zone)
    : at;
}

/** What a failed turn's own words and fields say of a usage limit. */
export interface LimitReading {
  /** Whether it is one for sure, or only maybe (needs a usage window). */
  sure: boolean;
  window: UsageLimitWindow;
  resetsAt: number | null;
  message: string;
}

/**
 * Whether a failed turn was a usage limit, from its structured fields first
 * and its words as a fallback.
 *
 * @returns null when nothing says so; `sure: false` when only a passing
 *   rate limit's fields say so, for the usage readers to settle.
 */
export function readFailure(
  failure: TurnFailure,
  now = Date.now(),
): LimitReading | null {
  const words = readsAsUsageLimit(failure.text);
  if (!failure.limited && !failure.throttled && !words) return null;
  const textWindow = windowOfText(failure.text);
  return {
    sure: Boolean(failure.limited) || words,
    window:
      failure.window && failure.window !== "unknown"
        ? failure.window
        : textWindow,
    resetsAt: failure.resetsAt ?? resetOfText(failure.text, now),
    message: failure.text.trim().slice(0, 500),
  };
}

// ─── Keeping the limits ─────────────────────────────────────────────────────

/** What the usage limits need from main. */
export interface UsageLimitsDeps {
  /** Tell every page the whole state. */
  emit: (state: UsageLimitsState) => void;
  /** The conversations whose engine runs a turn of `agent` now. */
  running: (agent: ConversationAgent) => {
    project: string;
    conversation: string;
    /** The model it runs on, when known. */
    model: string | null;
  }[];
  /** Stop a conversation's running turn, as the Stop button does. */
  stop: (project: string, conversation: string) => Promise<void>;
  /** Send `text` to a conversation through the normal send path. */
  send: (project: string, conversation: string, text: string) => Promise<void>;
  /** The agent's usage windows as its usage reader knows them now. */
  windows: (agent: ConversationAgent) => Promise<UsageWindowReading[]>;
  /**
   * Where the limits, stops and opt-ins are kept across a restart; nothing
   * is kept when absent.
   */
  file?: string;
}

/** A conversation stopped by a limit, and its continue timer. */
interface Stopped {
  agent: ConversationAgent;
  /** The scope of the limit that stopped it; null for the whole account. */
  scope: string | null;
  project: string;
  conversation: string;
  timer: (() => void) | null;
  continueAt: number | null;
  /**
   * When its limit was last known to reset, epoch ms: what a continue is
   * planned from once the limit itself is gone (it reset while the app was
   * closed).
   */
  resetsAt: number | null;
}

/** What the file holds. */
interface Kept {
  limits?: unknown;
  stopped?: unknown;
  optIn?: unknown;
}

/**
 * Run `fn` at `at` (epoch ms), however far off.
 *
 * NOTE: `setTimeout` fires at once past about 24.8 days, and a monthly
 * window can be further away than that: the wait is taken in steps.
 *
 * @returns Cancels it.
 */
function at(when: number, fn: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    const wait = when - Date.now();
    timer = setTimeout(
      wait > TIMER_MAX_MS ? arm : fn,
      Math.max(0, Math.min(wait, TIMER_MAX_MS)),
    );
    timer.unref?.();
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** `promise`, or `fallback` once `ms` passed first. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise
      .then(resolve, () => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

const keyOf = (project: string, conversation: string) =>
  `${project}\0${conversation}`;

/** The key of a limit: its agent, and its scope when it caps one family. */
const limitKeyOf = (agent: ConversationAgent, scope: string | null) =>
  `${agent}\0${scope ?? ""}`;

const AGENTS: readonly ConversationAgent[] = ["claude", "codex", "opencode"];
const WINDOWS: readonly UsageLimitWindow[] = [
  "5-hour",
  "weekly",
  "monthly",
  "unknown",
];

const isAgent = (value: unknown): value is ConversationAgent =>
  AGENTS.includes(value as ConversationAgent);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const scopeOf = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z]{1,32}$/.test(value) ? value : null;
const epochOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

/** A limit off the file, checked; null when it is not one. */
function keptLimit(value: unknown): UsageLimit | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (
    !isAgent(v.agent) ||
    !WINDOWS.includes(v.window as UsageLimitWindow) ||
    typeof v.resetsAt !== "string" ||
    !Number.isFinite(Date.parse(v.resetsAt)) ||
    typeof v.message !== "string" ||
    typeof v.at !== "string"
  )
    return null;
  return {
    agent: v.agent,
    scope: scopeOf(v.scope),
    window: v.window as UsageLimitWindow,
    resetsAt: v.resetsAt,
    message: v.message.slice(0, 500),
    at: v.at,
  };
}

/** The agents' usage limits, who they stopped, and who continues after. */
export function createUsageLimits(deps: UsageLimitsDeps) {
  const limits = new Map<string, { limit: UsageLimit; clear: () => void }>();
  const stopped = new Map<string, Stopped>();
  const optIn = new Map<string, { project: string; conversation: string }>();
  let disposed = false;
  let writing: Promise<void> = Promise.resolve();

  function state(): UsageLimitsState {
    return {
      limits: [...limits.values()].map((entry) => entry.limit),
      stopped: [...stopped.values()].map(
        (entry): UsageLimitStop => ({
          agent: entry.agent,
          project: entry.project,
          conversation: entry.conversation,
          autoContinue: entry.timer
            ? "scheduled"
            : optIn.has(keyOf(entry.project, entry.conversation))
              ? "unknown-reset"
              : "off",
          continueAt:
            entry.timer && entry.continueAt
              ? new Date(entry.continueAt).toISOString()
              : null,
        }),
      ),
      autoContinue: [...optIn.values()],
    };
  }

  /** Write what a restart needs; a failed write only costs that. */
  function persist(): void {
    const file = deps.file;
    if (!file || disposed) return;
    const kept = {
      // NOTE: A limit with no reset time is not kept: only a turn that goes
      // through clears it, and after a restart that may never be tried.
      limits: [...limits.values()]
        .map((entry) => entry.limit)
        .filter((limit) => limit.resetsAt !== null),
      stopped: [...stopped.values()].map((entry) => ({
        agent: entry.agent,
        scope: entry.scope,
        project: entry.project,
        conversation: entry.conversation,
        resetsAt: entry.resetsAt,
      })),
      optIn: [...optIn.values()],
    };
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(kept));
        await rename(temp, file);
      })
      .catch((error: unknown) =>
        console.error("Unable to keep the usage limits", error),
      );
  }

  const tell = () => {
    persist();
    deps.emit(state());
  };

  /** Let a limit go, and the stopped entries nothing will send. */
  function clearLimit(key: string): void {
    const entry = limits.get(key);
    if (!entry) return;
    entry.clear();
    limits.delete(key);
    const { agent, scope } = entry.limit;
    // A scheduled continue still goes at its time; one waiting on the
    // person has nothing left to wait for.
    for (const [itemKey, item] of stopped)
      if (item.agent === agent && item.scope === scope && !item.timer)
        stopped.delete(itemKey);
    tell();
  }

  /** Keep `limit`, cleared by itself once its reset passes. */
  function setLimit(limit: UsageLimit): void {
    const key = limitKeyOf(limit.agent, limit.scope);
    limits.get(key)?.clear();
    limits.set(key, {
      limit,
      clear: limit.resetsAt
        ? at(Date.parse(limit.resetsAt), () => clearLimit(key))
        : () => {},
    });
  }

  /**
   * Arm the continue of a stopped conversation, when it is opted in and its
   * limit's reset is known. Disarms it otherwise.
   */
  function arm(item: Stopped): void {
    item.timer?.();
    item.timer = null;
    item.continueAt = null;
    const key = keyOf(item.project, item.conversation);
    const live = limits.get(limitKeyOf(item.agent, item.scope))?.limit.resetsAt;
    if (live) item.resetsAt = Date.parse(live);
    const resetsAt = live ? Date.parse(live) : item.resetsAt;
    if (!optIn.has(key) || !resetsAt) return;
    const when = Math.max(resetsAt, Date.now()) + CONTINUE_MARGIN_MS;
    item.continueAt = when;
    item.timer = at(when, () => {
      item.timer = null;
      if (stopped.get(key) !== item) return;
      stopped.delete(key);
      tell();
      void deps
        .send(item.project, item.conversation, AUTO_CONTINUE_TEXT)
        .catch((error: unknown) =>
          console.error("Unable to continue after a usage limit", error),
        );
    });
  }

  /** Note a conversation as stopped by a limit of `agent` and `scope`. */
  function noteStopped(
    agent: ConversationAgent,
    scope: string | null,
    project: string,
    conversation: string,
  ): void {
    const key = keyOf(project, conversation);
    const item: Stopped = stopped.get(key) ?? {
      agent,
      scope,
      project,
      conversation,
      timer: null,
      continueAt: null,
      resetsAt: null,
    };
    item.agent = agent;
    item.scope = scope;
    stopped.set(key, item);
    arm(item);
  }

  /** A failed turn read as a usage limit: keep it, stop the turns under it. */
  async function hit(outcome: TurnOutcome, failure: TurnFailure) {
    const reading = readFailure(failure);
    if (!reading) return;
    const { agent } = outcome;
    const scope = failure.scope ?? null;
    let { window, resetsAt } = reading;
    // The usage readers settle what the CLI left open: whether a passing
    // rate limit was a usage limit, which window, and when it resets.
    if (!reading.sure || window === "unknown" || resetsAt === null) {
      const windows = await within(
        deps.windows(agent),
        READERS_TIMEOUT_MS,
        [] as UsageWindowReading[],
      );
      const named = windows.find(
        (entry) =>
          window !== "unknown" &&
          windowOfMinutes(entry.windowMinutes) === window,
      );
      const maxed = maxedWindow(windows);
      if (!reading.sure && !maxed) return;
      // NOTE: The readers know only the account's windows: a model family's
      // cap resets on its own clock, so it takes none of theirs.
      const source = scope ? null : (named ?? maxed);
      if (window === "unknown" && source)
        window = windowOfMinutes(source.windowMinutes);
      // NOTE: A reset already past is the reader's stale answer.
      if (resetsAt === null && source?.resetsAt && source.resetsAt > Date.now())
        resetsAt = source.resetsAt;
    }
    if (resetsAt !== null && resetsAt <= Date.now()) resetsAt = null;
    const before = limits.get(limitKeyOf(agent, scope));
    // A second report without a reset time keeps the first one's.
    const keep = before?.limit.resetsAt ?? null;
    const iso = resetsAt !== null ? new Date(resetsAt).toISOString() : keep;
    setLimit({
      agent,
      scope,
      window: window === "unknown" && before ? before.limit.window : window,
      resetsAt: iso,
      message: reading.message,
      at: before?.limit.at ?? new Date().toISOString(),
    });
    if (outcome.conversation)
      noteStopped(agent, scope, outcome.project, outcome.conversation);
    // A model family's cap stops only the turns on that family.
    const running = deps
      .running(agent)
      .filter((turn) => inScope(scope, turn.model, true));
    for (const turn of running)
      noteStopped(agent, scope, turn.project, turn.conversation);
    // Re-arm everything under this limit: the reset may have moved.
    for (const item of stopped.values())
      if (item.agent === agent && item.scope === scope) arm(item);
    tell();
    // As the Stop button: the CLI ends the turn; its process stays.
    await Promise.all(
      running.map((turn) =>
        deps.stop(turn.project, turn.conversation).catch(() => undefined),
      ),
    );
  }

  /** Take back what the file kept from before the last quit. */
  async function load(): Promise<void> {
    const file = deps.file;
    if (!file) return;
    let kept: Kept;
    try {
      kept = JSON.parse(await readFile(file, "utf8")) as Kept;
    } catch {
      return;
    }
    if (disposed) return;
    for (const entry of Array.isArray(kept.optIn) ? kept.optIn : []) {
      const v = (entry ?? {}) as Record<string, unknown>;
      if (!isText(v.project) || !isText(v.conversation)) continue;
      const key = keyOf(v.project, v.conversation);
      // An opt-in changed since the start is the person's newer word.
      if (!optIn.has(key) && optIn.size < OPT_IN_MAX)
        optIn.set(key, { project: v.project, conversation: v.conversation });
    }
    for (const entry of Array.isArray(kept.limits) ? kept.limits : []) {
      const limit = keptLimit(entry);
      if (!limit?.resetsAt || Date.parse(limit.resetsAt) <= Date.now())
        continue;
      if (!limits.has(limitKeyOf(limit.agent, limit.scope))) setLimit(limit);
    }
    for (const entry of Array.isArray(kept.stopped) ? kept.stopped : []) {
      const v = (entry ?? {}) as Record<string, unknown>;
      if (!isAgent(v.agent) || !isText(v.project) || !isText(v.conversation))
        continue;
      const key = keyOf(v.project, v.conversation);
      if (stopped.has(key)) continue;
      const scope = scopeOf(v.scope);
      const live = limits.has(limitKeyOf(v.agent, scope));
      // NOTE: A stop whose limit reset while the app was closed is kept only
      // when it is opted in: its continue goes now. Otherwise nothing is
      // left to wait for, as when a limit clears with the app open.
      if (!live && !optIn.has(key)) continue;
      const item: Stopped = {
        agent: v.agent,
        scope,
        project: v.project,
        conversation: v.conversation,
        timer: null,
        continueAt: null,
        resetsAt: epochOf(v.resetsAt),
      };
      stopped.set(key, item);
      arm(item);
    }
    tell();
  }

  // Reports are read one at a time: a limit hits every running turn of an
  // agent at once, and each must see what the one before it decided. The
  // file is read first, so a report never races what it kept.
  let queue: Promise<void> = load().catch((error: unknown) =>
    console.error("Unable to read the kept usage limits", error),
  );

  return {
    state,

    /** An engine's turn ended: read it for a usage limit. */
    report(outcome: TurnOutcome): void {
      queue = queue
        .then(async () => {
          if (outcome.failure) {
            await hit(outcome, outcome.failure);
            return;
          }
          // A turn that went through says the limits over it are gone:
          // bought usage, a banked reset spent, or a reset time never known.
          // NOTE: A turn on Sonnet says nothing of the Opus cap.
          for (const [key, entry] of [...limits])
            if (
              entry.limit.agent === outcome.agent &&
              inScope(entry.limit.scope, outcome.model, false)
            )
              clearLimit(key);
        })
        .catch((error: unknown) =>
          console.error("Unable to read a usage limit", error),
        );
    },

    /** Opt a conversation in to auto-continue, or out of it. */
    setAutoContinue(
      project: string,
      conversation: string,
      on: boolean,
    ): UsageLimitsState {
      const key = keyOf(project, conversation);
      optIn.delete(key);
      if (on) {
        optIn.set(key, { project, conversation });
        if (optIn.size > OPT_IN_MAX)
          optIn.delete(optIn.keys().next().value as string);
      }
      const item = stopped.get(key);
      if (item) arm(item);
      tell();
      return state();
    },

    /**
     * The person sent to `conversation` themselves, or handed it off: its
     * continue is not needed any more.
     */
    sent(project: string, conversation: string): void {
      const key = keyOf(project, conversation);
      const item = stopped.get(key);
      if (!item) return;
      item.timer?.();
      stopped.delete(key);
      tell();
    },

    /**
     * Every limit of `agent` was lifted early (a banked Codex reset spent):
     * an opted-in stop continues now, the others wait on the person.
     */
    lifted(agent: ConversationAgent): void {
      queue = queue
        .then(() => {
          for (const [key, entry] of [...limits])
            if (entry.limit.agent === agent) {
              entry.clear();
              limits.delete(key);
            }
          for (const [key, item] of [...stopped]) {
            if (item.agent !== agent) continue;
            item.resetsAt = Date.now();
            arm(item);
            if (!item.timer) stopped.delete(key);
          }
          tell();
        })
        .catch((error: unknown) =>
          console.error("Unable to lift a usage limit", error),
        );
    },

    /** The file's last write, done: for tests. */
    flushed: async (): Promise<void> => {
      await queue;
      await writing;
    },

    /** Drop every timer: app quit. */
    dispose(): void {
      disposed = true;
      for (const entry of limits.values()) entry.clear();
      for (const item of stopped.values()) item.timer?.();
      limits.clear();
      stopped.clear();
    },
  };
}

export type UsageLimits = ReturnType<typeof createUsageLimits>;
