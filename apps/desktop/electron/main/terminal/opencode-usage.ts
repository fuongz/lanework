// OpenCode Go's limits for the footer (FE-104/D10): rolling, weekly and
// monthly. First from OpenCode's own background service, which reads them
// with the account the user signed in with (`/api/experimental/usage/
// limits`); else from `opencode.ai/zen/go/v1/usage` with a Go API key.
//
// NOTE: The Go key is read here, used in that one request's Authorization
// header, and never logged, cached, returned or sent anywhere else. Only the
// percentages and reset times leave this file.
//
// Nothing here imports Electron: main decides whether to fetch at all (never
// in a test run), and a spec can drive the parsing and the key lookup with a
// fake environment and data folder.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OpenCodeUsage,
  OpenCodeUsageWindow,
} from "../../../shared/terminal";
import { createAgentCli } from "../conversation/claude-cli";
import { openCodeClient } from "../conversation/opencode-client";
import { parseServiceUrl } from "../conversation/opencode-service";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** The windows in the order the footer shows them, with their length. */
const WINDOWS = [
  ["rolling", 300],
  ["weekly", 10_080],
  ["monthly", 43_200],
] as const;

/**
 * Ask again after this long, Monocode's footer's 15 minutes; a failure waits
 * as long.
 */
const TTL_MS = 15 * 60_000;
/** Sooner once a window has started over since it was asked. */
const RESET_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/** A trimmed, non-blank string, or null. */
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** A `{env:VAR}` reference resolved, a plain key as it is. */
function resolveKey(value: unknown, env: NodeJS.ProcessEnv): string | null {
  const key = str(value);
  if (!key) return null;
  const ref = /^\{env:([^}]+)\}$/.exec(key)?.[1];
  return ref ? str(env[ref]) : key;
}

/** `auth.json`'s `opencode-go.key`, or null. */
function authKey(auth: unknown): string | null {
  if (!auth || typeof auth !== "object") return null;
  const go = (auth as Record<string, unknown>)["opencode-go"];
  return go && typeof go === "object"
    ? str((go as Record<string, unknown>).key)
    : null;
}

/** Drop `//` and block comments and trailing commas, outside strings. */
function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  for (let at = 0; at < raw.length; at++) {
    const ch = raw[at] as string;
    if (inString) {
      out += ch;
      if (ch === "\\") out += raw[++at] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && raw[at + 1] === "/") {
      while (at < raw.length && raw[at] !== "\n") at++;
      out += "\n";
    } else if (ch === "/" && raw[at + 1] === "*") {
      at = raw.indexOf("*/", at + 2);
      if (at === -1) break;
      at++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseConfig(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(stripJsonc(raw));
    } catch {
      return null;
    }
  }
}

/** A Go provider's `options.apiKey` in an OpenCode config, or null. */
function configKey(config: unknown, env: NodeJS.ProcessEnv): string | null {
  const providers = (config as { provider?: unknown } | null)?.provider;
  if (!providers || typeof providers !== "object") return null;
  for (const id of ["opencode-go", "opencode"]) {
    const options = (
      (providers as Record<string, unknown>)[id] as
        | { options?: { apiKey?: unknown } }
        | undefined
    )?.options;
    const key = resolveKey(options?.apiKey, env);
    if (key) return key;
  }
  return null;
}

/**
 * The OpenCode Go key, in OpenCode's own order (Monocode's
 * `usage/opencode.rs`):
 *
 * 1. `$OPENCODE_AUTH_CONTENT`: when it parses, it is the answer, key or not.
 * 2. A config's `provider.opencode-go.options.apiKey` (or `opencode`'s),
 *    `{env:VAR}` resolved: `$OPENCODE_CONFIG_CONTENT`, `$OPENCODE_CONFIG`,
 *    then the global `opencode.jsonc` / `opencode.json`.
 * 3. `<dataDir>/auth.json`'s `opencode-go.key`, else the one an older
 *    OpenCode kept in `~/Library/Application Support/opencode` on macOS.
 *
 * NOTE: Only for the account of the real home: `env` counts only there, as
 * for the data folder.
 */
export async function opencodeGoKey(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<string | null> {
  const blob = str(env.OPENCODE_AUTH_CONTENT);
  if (blob) {
    try {
      const auth = JSON.parse(blob) as unknown;
      if (auth && typeof auth === "object") return authKey(auth);
    } catch {
      // Not JSON: as if unset.
    }
  }
  const inline = str(env.OPENCODE_CONFIG_CONTENT);
  if (inline) {
    const key = configKey(parseConfig(inline), env);
    if (key) return key;
  }
  const configs = [
    str(env.OPENCODE_CONFIG),
    ...(str(env.XDG_CONFIG_HOME)
      ? [
          join(env.XDG_CONFIG_HOME as string, "opencode", "opencode.jsonc"),
          join(env.XDG_CONFIG_HOME as string, "opencode", "opencode.json"),
        ]
      : []),
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".config", "opencode", "opencode.json"),
  ].filter((file): file is string => Boolean(file));
  for (const file of configs) {
    const raw = await readFile(file, "utf8").catch(() => null);
    const key = raw === null ? null : configKey(parseConfig(raw), env);
    if (key) return key;
  }
  const raw =
    (await readFile(join(dataDir, "auth.json"), "utf8").catch(() => null)) ??
    (await readFile(
      join(home, "Library", "Application Support", "opencode", "auth.json"),
      "utf8",
    ).catch(() => null));
  if (raw === null) return null;
  try {
    return authKey(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Epoch seconds or ms, as a number or a string of digits, or ISO, to epoch
 * ms; null for anything else.
 *
 * NOTE: A string of digits is a number first: `Date.parse("1800000000")` is
 * NaN, and OpenCode Go sends its resets that way.
 */
export function resetOf(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value.trim())
        : null;
  if (numeric !== null)
    return Number.isFinite(numeric) && numeric > 0
      ? Math.round(numeric > 1e10 ? numeric : numeric * 1000)
      : null;
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The windows of a usage answer: `{ usage: { rolling, weekly, monthly } }`,
 * each `{ status, percent, resetsAt }` (`percent` is used, not left).
 *
 * A window of a status other than `ok` or `rate-limited`, or with no
 * percentage, is left out rather than guessed at.
 */
export function opencodeUsageWindows(body: unknown): OpenCodeUsageWindow[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const usage = (
    root.usage && typeof root.usage === "object" ? root.usage : root
  ) as Record<string, unknown>;
  const out: OpenCodeUsageWindow[] = [];
  for (const [name, minutes] of WINDOWS) {
    const raw = usage[name] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") continue;
    if (raw.status !== "ok" && raw.status !== "rate-limited") continue;
    const used = [raw.percent, raw.usedPercent].find(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
    if (used === undefined) continue;
    out.push({
      usedPercent: Math.min(100, Math.max(0, used)),
      windowMinutes: minutes,
      resetsAt: resetOf(raw.resetsAt) ?? resetOf(raw.resets_at),
      status: raw.status,
    });
  }
  return out;
}

/**
 * The limits OpenCode's service answered (FE-105): `{ go: { rolling, weekly,
 * monthly } }`, each `{ percent, limited, resetsAt }`. Null when it has no
 * `go`: the signed-in account has no Go subscription.
 */
export function opencodeServiceUsage(data: unknown): OpenCodeUsage | null {
  const go = (data as { go?: unknown } | null)?.go;
  if (!go || typeof go !== "object") return null;
  const windows: OpenCodeUsageWindow[] = [];
  for (const [name, minutes] of WINDOWS) {
    const raw = (go as Record<string, unknown>)[name] as
      | Record<string, unknown>
      | undefined;
    if (!raw || typeof raw !== "object") continue;
    const used = raw.percent;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    windows.push({
      usedPercent: Math.min(100, Math.max(0, used)),
      windowMinutes: minutes,
      resetsAt: resetOf(raw.resetsAt),
      status: raw.limited === true ? "rate-limited" : "ok",
    });
  }
  return windows.length
    ? { windows, at: new Date().toISOString(), error: null }
    : null;
}

const opencodeCli = createAgentCli("opencode");

function exec(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { env, timeout: 5_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  );
}

/**
 * What OpenCode's running service says of the account's limits; undefined
 * when the service is not running.
 *
 * NOTE: Never starts the service: Settings opening is no reason to run a
 * daemon the user did not. OpenCode holds the account's tokens; only its
 * answer, percentages and resets, comes here.
 */
export async function readServiceLimits(): Promise<unknown> {
  const cli = await opencodeCli();
  const url = parseServiceUrl(
    await exec(cli.file, ["service", "status"], cli.env).catch(() => ""),
  );
  if (!url) return undefined;
  const password = (
    await exec(cli.file, ["service", "get", "password"], cli.env)
  )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colours
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  if (!password || /\s/.test(password)) return undefined;
  return openCodeClient({ url, password }, null).request(
    "GET",
    "/api/experimental/usage/limits",
    undefined,
    TIMEOUT_MS,
  );
}

/**
 * Ask OpenCode Go for the key's limits, once.
 *
 * - No key, or 403 (a key without a Go subscription): null, and the footer
 *   shows no OpenCode chip.
 * - 401: the key was refused; `expired`, to sign in again.
 * - Anything else that fails: thrown, for the caller to keep what it had.
 */
export async function fetchOpencodeUsage(
  key: string | null,
  url = OPENCODE_GO_USAGE_URL,
): Promise<OpenCodeUsage | null> {
  if (!key) return null;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const at = new Date().toISOString();
  if (response.status === 403) return null;
  if (response.status === 401) return { windows: [], at, error: "expired" };
  if (!response.ok)
    throw new Error(`OpenCode Go usage failed (${response.status}).`);
  return {
    windows: opencodeUsageWindows(await response.json()),
    at,
    error: null,
  };
}

/**
 * The OpenCode Go usage the footer shows, asked at most every
 * {@link TTL_MS}, or every {@link RESET_TTL_MS} once one of its windows has
 * started over since (as Monocode's footer does).
 *
 * A read already running is shared. A failure keeps the last answer and waits
 * the TTL too: a network that is down is not asked on every listing.
 */
export function createOpencodeUsage(
  dataDir: () => string,
  service: () => Promise<unknown> = readServiceLimits,
) {
  let last: { usage: OpenCodeUsage | null; at: number } | null = null;
  let reading: Promise<OpenCodeUsage | null> | null = null;
  return async function opencodeUsage(): Promise<OpenCodeUsage | null> {
    if (last) {
      const now = Date.now();
      const asked = last.at;
      const reset = last.usage?.windows.some(
        (window) =>
          window.resetsAt !== null &&
          window.resetsAt > asked &&
          window.resetsAt <= now,
      );
      if (now - asked < (reset ? RESET_TTL_MS : TTL_MS)) return last.usage;
    }
    reading ??= (async () => {
      try {
        // The service first: it knows the account the user signed in with,
        // which has no Go key of its own (FE-105).
        const answer = await service().catch(() => undefined);
        const usage =
          answer !== undefined
            ? opencodeServiceUsage(answer)
            : await fetchOpencodeUsage(await opencodeGoKey(dataDir()));
        last = { usage, at: Date.now() };
      } catch {
        last = { usage: last?.usage ?? null, at: Date.now() };
      }
      return last.usage;
    })().finally(() => {
      reading = null;
    });
    return reading;
  };
}
