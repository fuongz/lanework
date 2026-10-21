// Claude's own usage endpoint, read with the CLI's OAuth credential (FE-53).
//
// NOTE: Read-only. The credential belongs to Claude Code, which rotates its
// refresh token. Refreshing or writing it here could race a live CLI and
// leave one of them with a spent refresh token, forcing a new sign-in. An
// expired access token is reported as `expired`, never renewed.
//
// NOTE: The token stays in this module: it is never logged, never cached
// beyond the one request, and only the windows below leave it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeQuotaWindow,
  ClaudeUsageError,
} from "../../../shared/terminal";

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The `anthropic-beta` header the endpoint asks for. */
const OAUTH_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";
const HTTP_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** Claude Code's Keychain service for the default config dir. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** The Keychain account Claude Code uses when `$USER` is unusable. */
const KEYCHAIN_FALLBACK_USER = "claude-code-user";
/** The most of a credential or an answer that is read, in bytes. */
const BODY_LIMIT = 64 * 1024;

/** The CLI's OAuth access token, and when it expires. */
export interface ClaudeCredential {
  token: string;
  /** Epoch ms; null when the credential does not say. */
  expiresAt: number | null;
}

/** What a fetch leaves behind: windows and times only, never the token. */
interface ClaudeOAuthSnapshot {
  primary: ClaudeQuotaWindow | null;
  secondary: ClaudeQuotaWindow | null;
  /** ISO time of the last successful fetch; null when none succeeded. */
  at: string | null;
  /** Epoch ms of the last attempt, success or not; null before the first. */
  fetchedAt: number | null;
  /** Why the newest attempt failed; null when it succeeded. */
  error: ClaudeUsageError | null;
}

/** One fetch's answer: the two windows, or why there are none. */
type FetchResult =
  | {
      ok: true;
      primary: ClaudeQuotaWindow | null;
      secondary: ClaudeQuotaWindow | null;
    }
  | { ok: false; error: ClaudeUsageError };

/** Claude Code's Keychain service for a config dir (its NFC sha256 prefix). */
export function claudeKeychainService(configDir?: string | null): string {
  if (!configDir) return KEYCHAIN_SERVICE;
  const digest = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex");
  return `${KEYCHAIN_SERVICE}-${digest.slice(0, 8)}`;
}

/**
 * The access token and expiry in a stored credential's JSON.
 *
 * Both the nested `claudeAiOauth` shape and a flat one are read.
 *
 * @returns null when `raw` is not JSON, or holds no token.
 */
export function claudeCredentialOf(raw: string): ClaudeCredential | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const blob = value as Record<string, unknown>;
  const nested =
    blob.claudeAiOauth && typeof blob.claudeAiOauth === "object"
      ? (blob.claudeAiOauth as Record<string, unknown>)
      : null;
  const token = nested?.accessToken ?? blob.accessToken;
  if (typeof token !== "string" || !token.trim()) return null;
  const expires = nested?.expiresAt ?? blob.expiresAt;
  const expiresAt =
    typeof expires === "number"
      ? expires
      : typeof expires === "string" && expires.trim()
        ? Number(expires.trim())
        : null;
  return {
    token: token.trim(),
    expiresAt:
      expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

/**
 * Whether the access token has expired.
 *
 * An unknown expiry counts as usable: the request then answers 401 if not.
 */
function claudeTokenExpired(
  credential: ClaudeCredential,
  now = Date.now(),
): boolean {
  return credential.expiresAt !== null && now >= credential.expiresAt;
}

/** The Keychain account for this user, or the fallback one. */
function keychainUser(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? "";
  return /^[A-Za-z0-9._-]+$/.test(user) ? user : KEYCHAIN_FALLBACK_USER;
}

/**
 * Run `/usr/bin/security` with `args`.
 *
 * @returns Its trimmed output, or null when it fails or prints nothing.
 */
function security(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    try {
      const child = execFile(
        "/usr/bin/security",
        args,
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          maxBuffer: BODY_LIMIT,
          windowsHide: true,
        },
        (error, stdout) => {
          const out = typeof stdout === "string" ? stdout.trim() : "";
          done(error || !out ? null : out);
        },
      );
      child.stdin?.end();
    } catch {
      done(null);
    }
  });
}

/**
 * The CLI's credential, read where Claude Code stores it.
 *
 * The macOS Keychain first (no account, then `$USER`, then Claude's fallback
 * account), else `<config>/.credentials.json`. `CLAUDE_CONFIG_DIR` selects
 * both.
 *
 * @returns null when no credential is found.
 */
export async function readClaudeCredential(
  options: {
    configDir?: string | null;
    home?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ClaudeCredential | null> {
  const configDir =
    options.configDir === undefined
      ? process.env.CLAUDE_CONFIG_DIR || null
      : options.configDir;
  if ((options.platform ?? process.platform) === "darwin") {
    const service = claudeKeychainService(configDir);
    const base = ["find-generic-password", "-s", service];
    for (const args of [
      [...base, "-w"],
      [...base, "-a", keychainUser(), "-w"],
      [...base, "-a", KEYCHAIN_FALLBACK_USER, "-w"],
    ]) {
      const secret = await security(args);
      const credential = secret ? claudeCredentialOf(secret) : null;
      if (credential) return credential;
    }
  }
  return readClaudeCredentialFile(
    join(
      configDir ?? join(options.home ?? homedir(), ".claude"),
      ".credentials.json",
    ),
  );
}

/**
 * The credential in a `.credentials.json` file.
 *
 * @returns null when the file is missing, too big, or holds none.
 */
export async function readClaudeCredentialFile(
  file: string,
): Promise<ClaudeCredential | null> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > BODY_LIMIT ? null : claudeCredentialOf(text);
  } catch {
    return null;
  }
}

/**
 * A window's reset time, in epoch ms.
 *
 * It may come as epoch seconds, epoch ms, or an ISO time.
 */
function resetAt(value: unknown): number | null {
  const ms = (n: number) =>
    !Number.isFinite(n) || n <= 0 ? null : n > 10_000_000_000 ? n : n * 1000;
  if (typeof value === "number") return ms(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return ms(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * One quota window of the answer.
 *
 * @param minutes How long the window is.
 * @returns null when the answer gives no usage for it.
 */
function oauthWindow(
  value: unknown,
  minutes: number,
): ClaudeQuotaWindow | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const used = [v.utilization, v.used_percentage, v.usedPercent].find(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  if (used === undefined) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowMinutes: minutes,
    resetsAt: resetAt(v.resets_at ?? v.resetsAt),
  };
}

/**
 * The five-hour and seven-day windows of the endpoint's answer.
 *
 * Every other field of the answer is dropped.
 *
 * @returns null when the answer has neither.
 */
export function claudeOAuthUsageOf(body: unknown): {
  primary: ClaudeQuotaWindow | null;
  secondary: ClaudeQuotaWindow | null;
} | null {
  if (!body || typeof body !== "object") return null;
  const v = body as Record<string, unknown>;
  const primary = oauthWindow(v.five_hour, 300);
  const secondary = oauthWindow(v.seven_day, 10080);
  return primary || secondary ? { primary, secondary } : null;
}

/** What a fetch of the endpoint may be given instead of the real thing. */
export interface ClaudeOAuthOptions {
  /** The credential source; {@link readClaudeCredential} by default. */
  readCredential?: () => Promise<ClaudeCredential | null>;
  fetch?: typeof fetch;
  url?: string;
  now?: () => number;
  /** How long a request may take before it counts as failed. */
  timeoutMs?: number;
  /** The shortest gap between automatic fetches (launch, poll, timer). */
  minIntervalMs?: number;
  /** The shortest gap between explicit refreshes. */
  forceIntervalMs?: number;
}

/**
 * Fetch the account's quota windows once.
 *
 * An expired token is never sent, and never renewed.
 */
export async function fetchClaudeOAuthUsage(
  options: ClaudeOAuthOptions = {},
): Promise<FetchResult> {
  const credential = await (
    options.readCredential ?? readClaudeCredential
  )().catch(() => null);
  if (!credential) return { ok: false, error: "unavailable" };
  if (claudeTokenExpired(credential, (options.now ?? Date.now)()))
    return { ok: false, error: "expired" };
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await (options.fetch ?? fetch)(
        options.url ?? CLAUDE_OAUTH_USAGE_URL,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "anthropic-beta": OAUTH_BETA,
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (response.status === 401)
        return { ok: false, error: "expired" } as const;
      if (response.status === 403)
        return { ok: false, error: "unavailable" } as const;
      if (!response.ok) return { ok: false, error: "failed" } as const;
      const text = await response.text();
      if (text.length > BODY_LIMIT)
        return { ok: false, error: "failed" } as const;
      const usage = claudeOAuthUsageOf(JSON.parse(text));
      return usage
        ? ({ ok: true, ...usage } as const)
        : ({ ok: false, error: "failed" } as const);
    })();
    request.catch(() => {});
    return await Promise.race([request, timeout]);
  } catch {
    return { ok: false, error: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One account-wide cache of the endpoint's answer.
 *
 * - Automatic reads fetch at most once a `minIntervalMs`.
 * - An explicit refresh bypasses that, but is still debounced by
 *   `forceIntervalMs`.
 * - Concurrent reads share one request.
 * - A failed fetch keeps the last good windows and only records why it
 *   failed.
 */
export function createClaudeOAuthUsage(options: ClaudeOAuthOptions = {}) {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? 60_000;
  const forceInterval = options.forceIntervalMs ?? 5_000;
  let snapshot: ClaudeOAuthSnapshot = {
    primary: null,
    secondary: null,
    at: null,
    fetchedAt: null,
    error: null,
  };
  let inflight: Promise<ClaudeOAuthSnapshot> | null = null;
  return {
    current: (): ClaudeOAuthSnapshot => ({ ...snapshot }),
    async read({ force = false } = {}): Promise<ClaudeOAuthSnapshot> {
      if (inflight) return inflight;
      const gap = force ? forceInterval : minInterval;
      if (snapshot.fetchedAt !== null && now() - snapshot.fetchedAt < gap)
        return { ...snapshot };
      inflight = (async () => {
        const started = now();
        const result = await fetchClaudeOAuthUsage(options);
        snapshot = result.ok
          ? {
              primary: result.primary,
              secondary: result.secondary,
              at: new Date(started).toISOString(),
              fetchedAt: started,
              error: null,
            }
          : { ...snapshot, fetchedAt: started, error: result.error };
        return { ...snapshot };
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
