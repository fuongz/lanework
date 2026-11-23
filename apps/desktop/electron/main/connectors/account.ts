// The claude.ai account's connectors (Gmail, Calendar, Figma…) for FE-166.
// No config file lists them.
//
// NOTE: The one record on disk is `claudeAiMcpEverConnected` in
// `~/.claude.json` (`readClaudeAiHint`), which only grows. The live list comes
// from `claude mcp list`, which health-checks every server, starting each stdio
// one (about 12 s on the dev machine). So it runs ONLY from `refreshAccount()`,
// which the user's Refresh calls. It never runs at app start, on a spawn or on a
// timer. One run at a time, 20 s at most. Its result is kept in the app home
// with `scannedAt` and read back lazily, once.
//
// Only each connector's name and status leave this file: the URL on its line
// is read past, never stored (a query string may hold a token).
//
// Nothing here imports Electron.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Connector } from "../../../shared/connectors";
import { afterMarker, runInLoginShell } from "../harness/shell";
import { appHomeDir } from "../paths";

/** What one account scan found; `scannedAt` is ISO 8601. */
export type AccountScan = {
  scannedAt: string;
  connectors: { name: string; auth: NonNullable<Connector["auth"]> }[];
};

/** How long `claude mcp list` may take, shell start included. */
const SCAN_MS = 20_000;
/** Connectors kept from one scan; more is not an account's list. */
const SCAN_MAX = 500;

const START = "__lanework_connectors_scan_start__";
const MISSING = "__lanework_connectors_scan_missing__";

/** Where the last scan is kept. */
export function accountCachePath(home = appHomeDir()): string {
  return join(home, "connectors", "claude-account.json");
}

/**
 * The claude.ai lines of `claude mcp list`:
 * `claude.ai Gmail: https://… - ✔ Connected`, `… - ! Needs authentication`,
 * `… - ✘ Failed to connect — …`. Every other line is skipped.
 */
export function parseClaudeMcpList(output: string): AccountScan["connectors"] {
  const found = new Map<string, NonNullable<Connector["auth"]>>();
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^(claude\.ai [^:]{1,200}): \S+(?: \([A-Za-z]+\))? +- +(.+)$/.exec(
        line.trim(),
      );
    const name = match?.[1]?.trim();
    if (!name || found.has(name)) continue;
    const status = match?.[2] ?? "";
    found.set(
      name,
      /needs auth/i.test(status)
        ? "needs-auth"
        : /^\W*connected\b/i.test(status)
          ? "ok"
          : "unknown",
    );
    if (found.size >= SCAN_MAX) break;
  }
  return [...found].map(([name, auth]) => ({ name, auth }));
}

function isScan(value: unknown): value is AccountScan {
  if (!value || typeof value !== "object") return false;
  const scan = value as Partial<AccountScan>;
  return (
    typeof scan.scannedAt === "string" &&
    Array.isArray(scan.connectors) &&
    scan.connectors.every(
      (entry) =>
        !!entry &&
        typeof entry.name === "string" &&
        ["ok", "needs-auth", "unknown"].includes(entry.auth),
    )
  );
}

let cached: Promise<AccountScan | null> | null = null;
let running: Promise<AccountScan> | null = null;

/** The last scan, read from disk once; null when none ran yet. */
export function accountScan(): Promise<AccountScan | null> {
  cached ??= readFile(accountCachePath(), "utf8").then(
    (text) => {
      try {
        const value: unknown = JSON.parse(text);
        return isScan(value) ? value : null;
      } catch {
        return null;
      }
    },
    () => null,
  );
  return cached;
}

async function save(scan: AccountScan): Promise<void> {
  const path = accountCachePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(scan, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function scan(): Promise<AccountScan> {
  if (process.platform === "win32")
    throw new Error("Connector scan is not available on Windows.");
  const line = (marker: string) => `printf '\\n%s\\n' '${marker}'`;
  const script = [
    `if ! command -v claude >/dev/null 2>&1; then ${line(MISSING)}; exit 0; fi`,
    line(START),
    "claude mcp list </dev/null 2>&1",
  ].join("; ");
  const { stdout, code } = await runInLoginShell(script, {
    timeoutMs: SCAN_MS,
  });
  if (afterMarker(stdout, MISSING) !== null)
    throw new Error("Claude Code is not installed.");
  const own = afterMarker(stdout, START);
  if (own === null || code === null)
    throw new Error("Claude Code did not list its connectors in time.");
  const result: AccountScan = {
    scannedAt: new Date().toISOString(),
    connectors: parseClaudeMcpList(own),
  };
  if (code !== 0 && !result.connectors.length)
    throw new Error("Claude Code could not list its connectors.");
  await save(result);
  return result;
}

/**
 * Run the account scan now, or join the one running.
 *
 * @throws When the CLI is missing, timed out or failed; the last scan stays.
 */
export function refreshAccount(): Promise<AccountScan> {
  running ??= scan()
    .then((result) => {
      cached = Promise.resolve(result);
      return result;
    })
    .finally(() => {
      running = null;
    });
  return running;
}
