// The Codex account's limits and banked resets, asked of `codex app-server`
// (FE-74): `account/rateLimits/read`, and `account/rateLimitResetCredit/
// consume` to spend one reset. The same calls Codex's own TUI makes, and
// monocode's usage footer.
//
// One `codex app-server` per request: started, `initialize`d, asked, stopped.
// Requests run one after another, never side by side.
//
// Nothing here imports Electron, so a spec can drive it under plain Node
// with a fake `codex`.
//
// NOTE: Codex reads its own credential. Nothing here opens `auth.json`, and
// the account id the answer carries never leaves this module.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  CodexQuota,
  CodexQuotaWindow,
  CodexResetCredit,
  CodexResetCredits,
  CodexResetOutcome,
} from "../../../shared/terminal";

/** Starting the app-server and answering `initialize`. */
const START_MS = 15_000;
/** The request itself, once initialized. */
const REQUEST_MS = 15_000;
/** The most of a single line read from the app-server. */
const LINE_MAX = 4 * 1024 * 1024;
/** Banked resets drawn at most. */
const CREDITS_MAX = 20;

/** The `codex` binary and the environment to run it with. */
export interface CodexCliRun {
  file: string;
  env: Record<string, string>;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Unix SECONDS from the app-server, to epoch ms. */
const seconds = (value: unknown): number | null => {
  const at = finite(value);
  return at === null || at <= 0 ? null : at * 1000;
};

let queue: Promise<unknown> = Promise.resolve();

/**
 * Ask `codex app-server` one thing.
 *
 * @throws When Codex does not start, does not answer in time, or answers
 *   with an error. The message is Codex's own, or how it stopped.
 */
export function codexAppServerRequest(
  cli: CodexCliRun,
  method: string,
  params: Json,
): Promise<unknown> {
  const run = queue.then(() => requestOnce(cli, method, params));
  queue = run.catch(() => undefined);
  return run;
}

function requestOnce(
  cli: CodexCliRun,
  method: string,
  params: Json,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cli.file, ["app-server"], {
        cwd: homedir(),
        env: cli.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = "";
    let stderr = "";
    let settled = false;
    let timer = setTimeout(
      () => finish(new Error("Codex did not start.")),
      START_MS,
    );
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      // Closed, not only signalled: a wrapper's child holding the pipes must
      // not keep main waiting on them. SIGKILL when SIGTERM is not enough.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill();
      const hard = setTimeout(() => child.kill("SIGKILL"), 3_000);
      hard.unref();
      child.once("exit", () => clearTimeout(hard));
      if (error) reject(error);
      else resolve(value);
    };
    const write = (message: Json) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        // A broken pipe shows as the exit.
      }
    };
    const onMessage = (message: Json) => {
      // The app-server asking us something: we have nothing to give.
      if (message.method !== undefined && message.id !== undefined) {
        write({ id: message.id, result: {} });
        return;
      }
      if (message.id === 1) {
        if (message.error)
          return finish(new Error(errorText(message.error, "initialize")));
        write({ method: "initialized" });
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new Error("Codex did not answer in time.")),
          REQUEST_MS,
        );
        write({ id: 2, method, params });
        return;
      }
      if (message.id === 2) {
        if (message.error)
          return finish(new Error(errorText(message.error, method)));
        finish(null, message.result);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          onMessage(record(JSON.parse(line)));
        } catch {
          // A line that is not JSON: Codex's, not ours to answer.
        }
      }
      if (buffer.length > LINE_MAX) buffer = "";
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2048);
    });
    child.stdin?.on("error", () => {});
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      const said = stderr
        .trim()
        .split("\n")
        .filter((line) => line.trim() && !/\b(WARN|INFO|DEBUG)\b/.test(line))
        .at(-1)
        ?.slice(0, 300);
      finish(
        new Error(
          said || `Codex stopped (${signal ?? `exit ${code ?? "?"}`}).`,
        ),
      );
    });
    write({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "lanework", title: "Lanework", version: "1.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
  });
}

function errorText(error: unknown, method: string): string {
  return text(record(error).message, 300) ?? `Codex refused ${method}.`;
}

/** One limit window of `account/rateLimits/read`. */
function windowOf(value: unknown): CodexQuotaWindow | null {
  const rec = record(value);
  const used = finite(rec.usedPercent);
  const minutes = finite(rec.windowDurationMins);
  const resetsAt = seconds(rec.resetsAt);
  if (used === null || minutes === null || minutes <= 0 || resetsAt === null)
    return null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    windowMinutes: minutes,
    resetsAt,
  };
}

const CREDIT_STATUSES = ["available", "redeeming", "redeemed"] as const;

function creditOf(value: unknown): CodexResetCredit | null {
  const rec = record(value);
  const id = text(rec.id, 200);
  if (!id) return null;
  return {
    id,
    status: (CREDIT_STATUSES as readonly unknown[]).includes(rec.status)
      ? (rec.status as CodexResetCredit["status"])
      : "unknown",
    title: text(rec.title),
    description: text(rec.description, 400),
    grantedAt: seconds(rec.grantedAt),
    expiresAt: seconds(rec.expiresAt),
  };
}

/** `rateLimitResetCredits`, or null when the answer has none. */
function creditsOf(value: unknown): CodexResetCredits | null {
  const rec = record(value);
  const available = finite(rec.availableCount);
  if (available === null) return null;
  const list = Array.isArray(rec.credits) ? rec.credits : [];
  return {
    availableCount: Math.max(0, Math.floor(available)),
    credits: list
      .map(creditOf)
      .filter((credit): credit is CodexResetCredit => credit !== null)
      .slice(0, CREDITS_MAX),
  };
}

/**
 * The quota in an `account/rateLimits/read` answer: the `codex` limit's
 * windows and plan, and the banked resets.
 *
 * @param at When it was asked, ISO.
 * @returns null when the answer has neither a window nor resets.
 */
export function codexQuotaOfAppServer(
  answer: unknown,
  at: string,
): CodexQuota | null {
  const rec = record(answer);
  const limits = record(
    record(rec.rateLimitsByLimitId).codex ?? rec.rateLimits,
  );
  const primary = windowOf(limits.primary);
  const secondary = windowOf(limits.secondary);
  const resetCredits = creditsOf(rec.rateLimitResetCredits);
  if (!primary && !secondary && !resetCredits) return null;
  return {
    primary,
    secondary,
    plan: text(limits.planType),
    at,
    resetCredits,
    source: "app-server",
  };
}

/** The account's limits and banked resets, asked of Codex now. */
export async function readCodexAppServerQuota(
  cli: CodexCliRun,
): Promise<CodexQuota | null> {
  const answer = await codexAppServerRequest(
    cli,
    "account/rateLimits/read",
    {},
  );
  return codexQuotaOfAppServer(answer, new Date().toISOString());
}

const OUTCOMES: readonly CodexResetOutcome[] = [
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
];

/**
 * Spend the banked reset `creditId`.
 *
 * ⚠️ Not undoable. Only ever on the user's confirmed click.
 */
export async function consumeCodexResetCredit(
  cli: CodexCliRun,
  creditId: string,
): Promise<CodexResetOutcome> {
  const answer = await codexAppServerRequest(
    cli,
    "account/rateLimitResetCredit/consume",
    { idempotencyKey: randomUUID(), creditId },
  );
  const outcome = record(answer).outcome;
  if ((OUTCOMES as readonly unknown[]).includes(outcome))
    return outcome as CodexResetOutcome;
  throw new Error("Codex answered the reset in a way Lanework does not know.");
}
