// The Stop hook for Claude Code, Codex and OpenCode (FE-104): leave a
// checkpoint on the lanework card this session is working, so another agent (Codex, or Claude in the
// cloud) can resume it once this one runs out of quota.
//
// NOTE: The desktop app installs it (Settings → Agents). The app bundles this
// file to `dist/electron/hook/lanework-checkpoint.cjs`, writes it into
// `~/.claude/settings.json` and runs it under Electron's own Node
// (`ELECTRON_RUN_AS_NODE=1`): the people using it have no bun. So: Node APIs
// only, no top-level await, no `import.meta`. It still runs under bun for
// development, and without the app:
//
//   bun apps/desktop/electron/hook/lanework-checkpoint.ts setup <lw_reg_…>
//
// Flags, set by whoever installs it: `--api <url>` (default
// https://api.lanework.dev; only https, or http on a loopback host), and
// `--push-wip`, the opt-in (FE-28/D3) to push uncommitted changes to tracked
// files to `refs/lanework/wip/<task-id>`. New files go too only with a second
// opt-in, `--push-wip-untracked` (FE-78/D9). Both can also come from the
// settings file; see `hookConfig()`.
//
// A repo linked to a board on this machine's local board (the SQLite file the
// app and the offline MCP share, never moved to the cloud) gets its
// checkpoint written there, with no credential and no network (FE-52/D9).
// See `local-board.ts`.
//
// OpenCode has no Stop hook: the app writes a plugin into its config folder
// that runs this hook with `--agent opencode` on `session.idle`, handing it
// `{ session_id, cwd }` on stdin. Its transcript is read, read-only, from
// OpenCode's own `opencode.db` (`node:sqlite`, loaded only then).
//
// It costs no model quota: it reads the transcript the CLI already wrote,
// and nothing here calls a model. That is the point: when the quota
// runs out mid-task, the last completed turn is still on the card.
//
// NOTE: It is never in the way. The hook proper only copies stdin to a temp
// file and spawns a detached worker, so a slow `git push` never holds up the
// next prompt. Every failure is logged to
// ~/.cache/lanework/checkpoint/hook.log and the exit code is always 0.
//
// NOTE: Redaction happens here, before anything leaves the machine. The
// server caps size but cannot tell a secret from prose.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, hostname, platform } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  AGENT_HEADER,
  type BoardsForRepoResponse,
  type CheckpointGit,
  type CheckpointRequest,
  DEFAULT_API_ORIGIN,
  isMachineSecret,
  type MachineRegisterRequest,
  type MachineRegisterResponse,
  paths,
  TOKEN_PREFIXES,
} from "@lanework/protocol";
import {
  config,
  desktopHookInstalled,
  login,
  logout,
  mcp,
  pluginConfigPath,
  status,
  waitForDeviceLogin,
} from "./cli";
import {
  credentialLocation,
  readSecret as readCredential,
  writeSecret,
} from "./credential";
import {
  type LocalBoard,
  localBoardFor,
  writeLocalCheckpoint,
} from "./local-board";
import { redact } from "./redact";

// `main/agent-setup/read.ts` and the tests import it from here.
export { redact };

/** `--flag value` / `--flag` anywhere; everything else is positional. */
function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (arg === "--api" || arg === "--agent") {
      flags.set(arg.slice(2), argv[++i] ?? "");
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { flags, positional };
}

const ARGS = parseArgs(process.argv.slice(2));

/** Hosts plain http may talk to: this machine only. */
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The API base `raw` names, if the hook may send the credential there.
 *
 * Only https, or http on a loopback host (a local control plane). Userinfo,
 * a query and a fragment are dropped (FE-78/D6).
 *
 * @returns Null for anything else.
 */
export function checkedApi(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ok =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!ok) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

const API_ASKED =
  (typeof ARGS.flags.get("api") === "string"
    ? (ARGS.flags.get("api") as string)
    : "") ||
  process.env.LANEWORK_API_URL ||
  DEFAULT_API_ORIGIN;
/** Set when the API asked for was refused; `main()` reports it. */
const API_REFUSED = checkedApi(API_ASKED) === null;
const API = checkedApi(API_ASKED) ?? DEFAULT_API_ORIGIN;

/** The settings the app (or `lanework config`) changes. */
type HookConfig = { pushWip?: boolean; pushWipUntracked?: boolean };

/**
 * Read the settings the app changes without touching the hook's command.
 *
 * Codex approves a hook by the hash of its command, so a switch flipped in
 * Settings must not change the command it approved (FE-29/D3).
 */
function hookConfig(): HookConfig {
  // The app's shim names its file; the plugin keeps one in ~/.config/lanework.
  const file =
    process.env.LANEWORK_HOOK_CONFIG ||
    (ARGS.flags.has("plugin") ? pluginConfigPath() : null);
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HookConfig;
  } catch {
    return {};
  }
}

const HOOK_CONFIG = hookConfig();
/** Whether to push unfinished code to the remote: opt-in (FE-28/D3). */
const PUSH_WIP = ARGS.flags.has("push-wip") || HOOK_CONFIG.pushWip === true;
/**
 * Whether that push includes new files: a second opt-in (FE-78/D9).
 *
 * `--push-wip-untracked`, or `"pushWipUntracked": true` in the same settings
 * file as `pushWip`. Without it the snapshot holds tracked files only.
 */
const PUSH_WIP_UNTRACKED =
  ARGS.flags.has("push-wip-untracked") || HOOK_CONFIG.pushWipUntracked === true;
/** Which CLI ran this turn: `claude-code`, `codex` or `opencode`. */
const AGENT =
  ARGS.flags.get("agent") === "codex"
    ? "codex"
    : ARGS.flags.get("agent") === "opencode"
      ? "opencode"
      : "claude-code";
const AGENT_NAME =
  AGENT === "codex"
    ? "Codex"
    : AGENT === "opencode"
      ? "OpenCode"
      : "Claude Code";
const STATE_DIR = join(homedir(), ".cache", "lanework", "checkpoint");
const LOG = join(STATE_DIR, "hook.log");
/** An unchanged turn inside this window writes nothing (BE-17/D10). */
const THIN_MS = 60_000;
const PUSH_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

// ── Small utilities ─────────────────────────────────────────────────────────

/** A line in hook.log: redacted, in a file only this user can read. */
function log(message: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (existsSync(LOG)) {
      const { size, mode } = statSync(LOG);
      if (size > 512 * 1024) rmSync(LOG);
      else if (mode & 0o077) chmodSync(LOG, 0o600);
    }
    appendFileSync(LOG, `${new Date().toISOString()} ${redact(message)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Logging is the last resort; there is nowhere left to report to.
  }
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PUSH_TIMEOUT_MS,
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

/**
 * A touched file as the card shows it: relative to the repo.
 *
 * @returns Null for a path outside the repo, which would tell the server
 *   about the rest of the disk (FE-78/D3).
 */
function repoPath(path: string, root: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const rel = isAbsolute(trimmed) ? relative(root, trimmed) : trimmed;
  if (!rel || isAbsolute(rel) || rel.startsWith("..") || rel.startsWith("~"))
    return null;
  return rel;
}

// ── Transcript ──────────────────────────────────────────────────────────────

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};
type Line = {
  type?: string;
  isSidechain?: boolean;
  message?: { content?: string | Block[] };
};

export type Digest = {
  taskId: string | null;
  request: string | null;
  lastReply: string | null;
  /** `lastReply` is the previous turn's: this one had not replied yet. */
  replyIsPrevious: boolean;
  files: string[];
  commands: { command: string; ok: boolean | null }[];
};

/** Text a human typed, or null for injected context (reminders, commands). */
function humanText(content: string | Block[] | undefined): string | null {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n")
        : "";
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  if (!text || text.startsWith("<")) return null;
  return text;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

/** A task id as boards mint them by default: `BE-17`, `FE-09`, `INF-01`. */
const TASK_ID = /\b[A-Z]{2,5}-\d{1,5}\b/g;
/** Prefixes that look like a {@link TASK_ID} and are not one. */
const NOT_TASK_ID = /^(?:UTF|SHA|ISO|RFC|HTTP|TLS|CVE|MD|AES|RSA|ES|ECMA)-/;

/**
 * Condense a Claude Code transcript into what the next agent needs.
 *
 * NOTE: The card is the one this session talked to the board about: the last
 * `card` a lanework tool was called with, or the task id `create_review`
 * returned (BE-17/D11). Only when there is none does a task id the user typed
 * count. A stray `UTF-8` then fails the server's lookup, which is a 404 and a
 * log line, not a baton on the wrong card.
 */
export function digest(transcript: string, root: string): Digest {
  const lines: Line[] = [];
  for (const raw of transcript.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      // A line being written as we read. Skip it.
    }
  }

  let mcpTaskId: string | null = null;
  let typedTaskId: string | null = null;
  let request: string | null = null;
  let replies: string[] = [];
  let previousReplies: string[] = [];
  const uses = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  const failed = new Map<string, boolean>();
  const files: string[] = [];
  const commandIds: string[] = [];

  for (const line of lines) {
    if (line.isSidechain) continue;
    const content = line.message?.content;
    if (line.type === "user") {
      const typed = humanText(content);
      if (typed) {
        request = typed;
        // NOTE: The previous turn's reply is kept until this turn writes one.
        // A worker that runs mid-turn (or a turn that ends in tool calls)
        // would otherwise report "no reply" and lose where the work stood.
        if (replies.length) previousReplies = replies;
        replies = [];
        for (const m of typed.match(TASK_ID) ?? []) {
          if (!NOT_TASK_ID.test(m)) typedTaskId = m;
        }
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          failed.set(b.tool_use_id, b.is_error === true);
          const use = uses.get(b.tool_use_id);
          if (use?.name.startsWith("mcp__lanework__")) {
            const minted = /"taskId":\s*"([^"]+)"/.exec(resultText(b.content));
            if (minted?.[1] && use.name.endsWith("create_review")) {
              mcpTaskId = minted[1];
            }
          }
        }
      }
    } else if (line.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text?.trim()) replies.push(b.text.trim());
        if (b.type !== "tool_use" || !b.id || !b.name) continue;
        const input = b.input ?? {};
        uses.set(b.id, { name: b.name, input });
        if (
          b.name.startsWith("mcp__lanework__") &&
          typeof input.card === "string"
        ) {
          mcpTaskId = input.card;
        }
        if (["Edit", "Write", "NotebookEdit"].includes(b.name)) {
          const path = input.file_path ?? input.notebook_path;
          if (typeof path === "string") {
            const rel = repoPath(path, root);
            if (rel) {
              // Most recently touched last, each path once.
              const at = files.indexOf(rel);
              if (at !== -1) files.splice(at, 1);
              files.push(rel);
            }
          }
        }
        if (b.name === "Bash" && typeof input.command === "string") {
          commandIds.push(b.id);
        }
      }
    }
  }

  const commands = commandIds.slice(-15).map((id) => ({
    command: clip(
      String(uses.get(id)?.input.command ?? "").split("\n")[0] ?? "",
      300,
    ),
    ok: failed.has(id) ? !failed.get(id) : null,
  }));

  return {
    taskId: mcpTaskId ?? typedTaskId,
    request,
    lastReply:
      (replies.length ? replies : previousReplies).join("\n\n") || null,
    replyIsPrevious: !replies.length && previousReplies.length > 0,
    files: files.slice(-100),
    commands,
  };
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** A string in JS source: "…", '…' or `…`, escapes included. */
const JS_STRING = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/
  .source;
/** `card: "BE-17"` in code-mode JS, or `"card":"BE-17"` in JSON arguments. */
const CARD_ARG = new RegExp(/["']?\bcard["']?\s*:\s*/.source + JS_STRING, "g");
const EXEC_CMD = new RegExp(
  /exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*/.source + JS_STRING,
  "g",
);
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g;
/** A tool call that talks to the Lanework MCP server, however it is spelled. */
const LANEWORK_CALL =
  /lanework|\b(?:get_review|toggle_item|update_review|set_status|review_card|create_review|list_reviews)\b/;

/** The JS literal's value. `JSON.parse` covers "…"; the rest are unwrapped. */
function unquote(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Find the rollout file for a Codex session when the hook was not told one.
 *
 * Rollouts are named `rollout-<time>-<session id>.jsonl`, in a folder per
 * day. Only the newest three days are searched: a session that is still
 * running wrote to one of them today or yesterday.
 */
function findCodexRollout(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const base = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "sessions",
  );
  const ls = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [] as string[];
    }
  };
  let days = 0;
  for (const year of ls(base))
    for (const month of ls(join(base, year)))
      for (const day of ls(join(base, year, month))) {
        if (++days > 3) return null;
        const dir = join(base, year, month, day);
        const hit = ls(dir).find((name) => name.endsWith(`${sessionId}.jsonl`));
        if (hit) return join(dir, hit);
      }
  return null;
}

type CodexItem = {
  type?: string;
  content?: { text?: unknown }[];
  command?: unknown;
  exit_code?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  result?: unknown;
};

type CodexLine = {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    name?: string;
    arguments?: unknown;
    input?: unknown;
    call_id?: string;
    output?: unknown;
    item?: CodexItem;
  };
};

const texts = (content: CodexItem["content"]): string =>
  (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

/**
 * Condense a Codex rollout the way {@link digest} does a Claude transcript.
 *
 * It reads `item_completed` events (`UserMessage`, `AgentMessage`,
 * `CommandExecution` with its exit code, `FileChange`, `McpToolCall`), which
 * Codex writes for every item whatever mode it ran tools in. Only a rollout
 * with none of them (an older Codex) falls back to reading the `exec` scripts
 * of "code mode" by pattern. The final answer comes from the hook's stdin
 * (`last_assistant_message`) when Codex sends it, which is exact.
 */
export function digestCodex(
  transcript: string,
  root: string,
  lastMessage: string | null,
): Digest {
  let mcpTaskId: string | null = null;
  let typedTaskId: string | null = null;
  let request: string | null = null;
  let replies: string[] = [];
  let previousReplies: string[] = [];
  let structured = false;
  const files: string[] = [];
  const commands: { command: string; ok: boolean | null }[] = [];
  // The code-mode fallback, used only when no structured item was seen.
  let scriptTaskId: string | null = null;
  const scriptFiles: string[] = [];
  const scriptCommands: { command: string; ok: boolean | null }[] = [];
  const calls = new Map<string, string>();

  const touch = (list: string[], path: string) => {
    const rel = repoPath(path.trim().replace(/^file:\/\//, ""), root);
    if (!rel) return;
    const at = list.indexOf(rel);
    if (at !== -1) list.splice(at, 1);
    list.push(rel);
  };
  const typed = (text: string) => {
    if (!text || text.startsWith("<") || text.startsWith("# AGENTS.md")) return;
    request = text;
    if (replies.length) previousReplies = replies;
    replies = [];
    for (const m of text.match(TASK_ID) ?? [])
      if (!NOT_TASK_ID.test(m)) typedTaskId = m;
  };

  for (const raw of transcript.split("\n")) {
    if (!raw.trim()) continue;
    let line: CodexLine;
    try {
      line = JSON.parse(raw) as CodexLine;
    } catch {
      continue;
    }
    const p = line.payload ?? {};
    const item = p.type === "item_completed" ? p.item : undefined;
    if (item) {
      structured = true;
      if (item.type === "UserMessage") typed(texts(item.content));
      else if (item.type === "AgentMessage") {
        const text = texts(item.content);
        if (text) replies.push(text);
      } else if (item.type === "CommandExecution") {
        const argv = Array.isArray(item.command) ? item.command : [];
        const script = String(argv[argv.length - 1] ?? "");
        commands.push({
          command: clip(script.split("\n")[0] ?? "", 300),
          ok: typeof item.exit_code === "number" ? item.exit_code === 0 : null,
        });
      } else if (item.type === "FileChange" && item.changes) {
        for (const path of Object.keys(item.changes as object))
          touch(files, path);
      } else if (
        item.type === "McpToolCall" &&
        typeof item.server === "string" &&
        item.server.includes("lanework")
      ) {
        const args = (item.arguments ?? {}) as { card?: unknown };
        if (typeof args.card === "string") mcpTaskId = args.card;
        if (item.tool === "create_review") {
          const minted = /\\?"taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(
            JSON.stringify(item.result ?? ""),
          );
          if (minted?.[1]) mcpTaskId = minted[1];
        }
      }
      continue;
    }
    if (line.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      // Only when there are no structured items; see `structured` below.
      if (!structured) typed(texts((p as CodexItem).content));
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const source =
        typeof p.input === "string"
          ? p.input
          : typeof p.arguments === "string"
            ? p.arguments
            : "";
      const blob = `${p.name ?? ""}\n${source}`;
      if (p.call_id) calls.set(p.call_id, blob);
      if (LANEWORK_CALL.test(blob))
        for (const m of blob.matchAll(CARD_ARG))
          scriptTaskId = unquote(m[1] ?? "");
      for (const m of blob.matchAll(PATCH_FILE)) touch(scriptFiles, m[1] ?? "");
      for (const m of blob.matchAll(EXEC_CMD))
        scriptCommands.push({
          command: clip(unquote(m[1] ?? "").split("\n")[0] ?? "", 300),
          ok: null,
        });
    } else if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output"
    ) {
      const call = (p.call_id && calls.get(p.call_id)) || "";
      if (!call.includes("create_review")) continue;
      const out =
        typeof p.output === "string"
          ? p.output
          : JSON.stringify(p.output ?? "");
      const minted = /\\?"taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(out);
      if (minted?.[1]) scriptTaskId = minted[1];
    }
  }

  const fromStdin = lastMessage?.trim() || null;
  const turn = replies.length ? replies : previousReplies;
  return {
    taskId: (structured ? mcpTaskId : scriptTaskId) ?? typedTaskId,
    request,
    lastReply: fromStdin ?? (turn.join("\n\n") || null),
    replyIsPrevious:
      !fromStdin && !replies.length && previousReplies.length > 0,
    files: (structured ? files : scriptFiles).slice(-100),
    commands: (structured ? commands : scriptCommands).slice(-15),
  };
}

// ── OpenCode (FE-104) ───────────────────────────────────────────────────────

/** One tool call of an OpenCode message, in either schema. */
export type OpencodeTool = {
  name: string;
  input: Record<string, unknown>;
  status: string | null;
  /** What the tool returned, as text; empty when it kept none. */
  output: string;
  /** A shell command's exit code, when OpenCode recorded one. */
  exit: number | null;
};

/** One message of an OpenCode session, flattened from either schema. */
export type OpencodeMessage = {
  role: "user" | "assistant";
  texts: string[];
  tools: OpencodeTool[];
};

/**
 * Where OpenCode keeps its data: `$OPENCODE_DATA_DIR`, else
 * `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`.
 */
function opencodeDataDir(): string {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR;
  if (process.env.XDG_DATA_HOME)
    return join(process.env.XDG_DATA_HOME, "opencode");
  return join(homedir(), ".local", "share", "opencode");
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** A tool call from a 2.x content block or a 1.x part. */
function opencodeTool(block: Record<string, unknown>): OpencodeTool | null {
  const name =
    typeof block.name === "string"
      ? block.name
      : typeof block.tool === "string"
        ? block.tool
        : null;
  if (!name) return null;
  const state = asObject(block.state);
  const metadata = asObject(state.metadata);
  const output =
    typeof state.output === "string"
      ? state.output
      : Array.isArray(state.content)
        ? state.content
            .map((part) => {
              const text = asObject(part).text;
              return typeof text === "string" ? text : "";
            })
            .join("\n")
        : "";
  return {
    name,
    input: asObject(state.input),
    status: typeof state.status === "string" ? state.status : null,
    output,
    exit: typeof metadata.exit === "number" ? metadata.exit : null,
  };
}

/** The 2.x rows of one session: `session_message`, its content inline. */
function opencodeV2Messages(
  db: import("node:sqlite").DatabaseSync,
  sessionId: string,
): OpencodeMessage[] {
  const rows = db
    .prepare(
      `SELECT type, data FROM session_message
        WHERE session_id = ? AND type IN ('user', 'assistant')
        ORDER BY seq`,
    )
    .all(sessionId) as { type: unknown; data: unknown }[];
  const messages: OpencodeMessage[] = [];
  for (const row of rows) {
    const data = parseData(row.data);
    if (row.type === "user") {
      const text = typeof data.text === "string" ? data.text : "";
      messages.push({ role: "user", texts: [text], tools: [] });
      continue;
    }
    const message: OpencodeMessage = {
      role: "assistant",
      texts: [],
      tools: [],
    };
    for (const raw of Array.isArray(data.content) ? data.content : []) {
      const block = asObject(raw);
      if (block.type === "text" && typeof block.text === "string")
        message.texts.push(block.text);
      else if (block.type === "tool") {
        const tool = opencodeTool(block);
        if (tool) message.tools.push(tool);
      }
    }
    messages.push(message);
  }
  return messages;
}

/** The 1.x rows of one session: `message`, each with its `part`s. */
function opencodeV1Messages(
  db: import("node:sqlite").DatabaseSync,
  sessionId: string,
): OpencodeMessage[] {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.data AS message, p.data AS part
         FROM message m LEFT JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY m.time_created, m.id, p.id`,
    )
    .all(sessionId) as { id: unknown; message: unknown; part: unknown }[];
  const messages: OpencodeMessage[] = [];
  let current = null as { id: unknown; message: OpencodeMessage } | null;
  for (const row of rows) {
    if (current?.id !== row.id) {
      const role = parseData(row.message).role;
      current =
        role === "user" || role === "assistant"
          ? { id: row.id, message: { role, texts: [], tools: [] } }
          : null;
      if (current) messages.push(current.message);
    }
    if (!current) continue;
    const part = parseData(row.part);
    // A synthetic part is context OpenCode added, not what anyone typed.
    if (part.type === "text" && typeof part.text === "string") {
      if (part.synthetic !== true) current.message.texts.push(part.text);
    } else if (part.type === "tool") {
      const tool = opencodeTool(part);
      if (tool) current.message.tools.push(tool);
    }
  }
  return messages;
}

/**
 * Read one OpenCode session's messages, read-only.
 *
 * 2.x keeps them in `session_v2` and `session_message`; 1.x in `session`,
 * `message` and `part`. `node:sqlite` is loaded here, not at the top, so a
 * Node without it (the plugin's user Node, under 22.5) costs OpenCode's
 * checkpoints only.
 *
 * @returns Null when the database, the session or `node:sqlite` is missing.
 */
export function readOpencodeSession(
  sessionId: string,
  file: string = join(opencodeDataDir(), "opencode.db"),
): { directory: string | null; messages: OpencodeMessage[] } | null {
  if (!existsSync(file)) return null;
  const sqlite = process.getBuiltinModule?.("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (!sqlite) {
    log("node:sqlite is not available; OpenCode's session cannot be read");
    return null;
  }
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const has = (table: string) =>
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) !== undefined;
    for (const [sessions, read] of [
      ["session_v2", opencodeV2Messages],
      ["session", opencodeV1Messages],
    ] as const) {
      if (!has(sessions)) continue;
      const session = db
        .prepare(`SELECT directory FROM ${sessions} WHERE id = ?`)
        .get(sessionId) as { directory?: unknown } | undefined;
      if (!session) continue;
      return {
        directory:
          typeof session.directory === "string" ? session.directory : null,
        messages: read(db, sessionId),
      };
    }
    return null;
  } finally {
    db.close();
  }
}

/** OpenCode's tools that write a file; `filePath` names it. */
const OPENCODE_FILE_TOOLS = new Set(["edit", "write", "multiedit", "patch"]);

/**
 * Condense an OpenCode session the way {@link digest} does a Claude
 * transcript.
 *
 * NOTE: OpenCode names an MCP tool `<server>_<tool>`, so ours are
 * `lanework_get_review`, `lanework_create_review`, and so on.
 */
export function digestOpencode(
  messages: OpencodeMessage[],
  root: string,
): Digest {
  let mcpTaskId: string | null = null;
  let typedTaskId: string | null = null;
  let request: string | null = null;
  let replies: string[] = [];
  let previousReplies: string[] = [];
  const files: string[] = [];
  const commands: { command: string; ok: boolean | null }[] = [];
  const touch = (path: string) => {
    const rel = repoPath(path, root);
    if (!rel) return;
    const at = files.indexOf(rel);
    if (at !== -1) files.splice(at, 1);
    files.push(rel);
  };

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.texts
        .join("\n")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .trim();
      if (!text || text.startsWith("<")) continue;
      request = text;
      if (replies.length) previousReplies = replies;
      replies = [];
      for (const m of text.match(TASK_ID) ?? [])
        if (!NOT_TASK_ID.test(m)) typedTaskId = m;
      continue;
    }
    for (const text of message.texts)
      if (text.trim()) replies.push(text.trim());
    for (const tool of message.tools) {
      const { name, input } = tool;
      if (name.startsWith("lanework_")) {
        if (typeof input.card === "string") mcpTaskId = input.card;
        if (name.endsWith("create_review")) {
          const minted = /\\?"taskId\\?"\s*:\s*\\?"([^"\\]+)/.exec(tool.output);
          if (minted?.[1]) mcpTaskId = minted[1];
        }
      }
      if (OPENCODE_FILE_TOOLS.has(name)) {
        const path = input.filePath ?? input.file_path ?? input.path;
        if (typeof path === "string") touch(path);
      }
      if (name === "apply_patch" && typeof input.patchText === "string")
        for (const m of input.patchText.matchAll(PATCH_FILE))
          touch((m[1] ?? "").trim());
      if (name === "bash" && typeof input.command === "string")
        commands.push({
          command: clip(input.command.split("\n")[0] ?? "", 300),
          ok:
            tool.status === "error"
              ? false
              : tool.exit !== null
                ? tool.exit === 0
                : tool.status === "completed"
                  ? true
                  : null,
        });
    }
  }

  return {
    taskId: mcpTaskId ?? typedTaskId,
    request,
    lastReply:
      (replies.length ? replies : previousReplies).join("\n\n") || null,
    replyIsPrevious: !replies.length && previousReplies.length > 0,
    files: files.slice(-100),
    commands: commands.slice(-15),
  };
}

// ── Credential and board ────────────────────────────────────────────────────

/** This machine's credential, wherever this install keeps it. */
const readSecret = () => readCredential(API);

async function http(
  path: string,
  init: RequestInit & { secret?: string } = {},
): Promise<Response> {
  const { secret, ...rest } = init;
  return fetch(`${API}${path}`, {
    ...rest,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      [AGENT_HEADER]: AGENT,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * `remote` without the userinfo a remote URL can carry (`https://<PAT>@…`).
 *
 * It is what the board lookup, hook.log and boards.json see, never the raw
 * URL (FE-78/D2). An scp-like remote (`git@host:owner/repo`) is left as it
 * is: its user is an ssh login, never a password or a token.
 */
export function stripUserinfo(remote: string): string {
  const value = remote.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      // Untouched when there is nothing to strip: the same spelling as ever.
      if (!url.username && !url.password) return value;
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      // Not a URL after all: cut what sits between `://` and the last `@`
      // before the host.
      return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
    }
  }
  return value;
}

/** How long a board found for a repo is trusted without asking again. */
const BOARD_TTL_MS = 60 * 60 * 1000;
const BOARDS_FILE = join(STATE_DIR, "boards.json");
type BoardCache = Record<string, { id: string; at: number }>;

/**
 * The boards.json key for `remote` (already stripped).
 *
 * The API and a hash of the credential are part of it, so another API or
 * another sign-in never reuses a board found for this one (FE-78/D5).
 */
function boardKey(remote: string, secret: string): string {
  return [API, sha256(secret).slice(0, 12), remote].join(" ");
}

function readBoards(): BoardCache {
  const cache = readJson<Record<string, unknown>>(BOARDS_FILE, {});
  const fresh: BoardCache = {};
  const now = Date.now();
  for (const [key, entry] of Object.entries(cache)) {
    // Entries from before FE-78 are bare ids: dropped, never trusted.
    const e = entry as { id?: unknown; at?: unknown } | null;
    if (
      e &&
      typeof e.id === "string" &&
      typeof e.at === "number" &&
      now - e.at < BOARD_TTL_MS
    )
      fresh[key] = { id: e.id, at: e.at };
  }
  return fresh;
}

/** Forget the board found for `remote`: the server no longer agrees. */
function evictBoard(remote: string, secret: string): void {
  const cache = readBoards();
  const key = boardKey(remote, secret);
  if (!(key in cache)) return;
  delete cache[key];
  writeJson(BOARDS_FILE, cache);
}

async function boardFor(
  remote: string,
  secret: string,
): Promise<string | null> {
  const cache = readBoards();
  const key = boardKey(remote, secret);
  const hit = cache[key];
  if (hit) return hit.id;
  const res = await http(paths.boardsForRepo(remote), { secret });
  if (!res.ok) {
    log(`board lookup ${res.status} for ${remote}`);
    return null;
  }
  const { boards } = (await res.json()) as BoardsForRepoResponse;
  // Same rule as the MCP server's: exactly one, or none at all.
  if (boards.length !== 1) {
    log(`${boards.length} boards linked to ${remote}; not guessing`);
    return null;
  }
  const id = boards[0]?.workspaceId ?? null;
  if (id) writeJson(BOARDS_FILE, { ...cache, [key]: { id, at: Date.now() } });
  return id;
}

// ── Git: where the code is (BE-17/D1) ───────────────────────────────────────

/**
 * File names that hold secrets by convention: never in a WIP snapshot.
 *
 * Matched against the base name, case-insensitively. `.env.example` and its
 * kin are templates, not secrets.
 */
const SECRET_FILES = [
  /^\.env(?!\.(?:example|sample|template|dist|defaults)$)(?:\..*)?$/,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/,
  /\.tfstate(?:\..*)?$/,
  /\.tfvars(?:\.json)?$/,
  /^service[-_]?account.*\.json$/,
  /^credentials.*\.json$/,
  /^client_secret.*\.json$/,
  /^(?:\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.htpasswd|\.pgpass|\.dockercfg|\.s3cfg|\.boto)$/,
];

/** Whether `path` (repo-relative) names a file that holds secrets. */
export function isSecretFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return SECRET_FILES.some((pattern) => pattern.test(name));
}

/**
 * Why the snapshot in `index` must not leave the machine, or null.
 *
 * It looks at every path that differs from `HEAD` and at every line the
 * snapshot adds: a secret-looking file name, or a line `redact()` would
 * change, keeps the whole snapshot home (FE-78/D9).
 */
function refusal(root: string, env: NodeJS.ProcessEnv): string | null {
  const changed = git(
    root,
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT", "HEAD"],
    env,
  )
    .split("\0")
    .filter(Boolean);
  const file = changed.find(isSecretFile);
  if (file) return `${file} looks like a secrets file`;
  // NOTE: Only the lines it adds. A secret already in HEAD is not this
  // push's to leak, and a test fixture untouched this turn must not block
  // every snapshot.
  const patch = execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-filter=ACMRT",
      "HEAD",
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: PUSH_TIMEOUT_MS,
    },
  );
  let current = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line.slice(4).replace(/^b\//, "");
    } else if (line.startsWith("+") && redact(line) !== line) {
      return `an added line in ${current} looks like a secret`;
    }
  }
  return null;
}

/**
 * Snapshot the working tree as a commit on no branch, and push it.
 *
 * The snapshot holds changes to tracked files; untracked files that are not
 * ignored only with `--push-wip-untracked` (FE-78/D9). It goes to
 * `refs/lanework/wip/<id>`, force-pushed: it is a baton, only the latest
 * matters. A snapshot that looks like it holds a secret is not pushed at all.
 *
 * NOTE: It uses a private index (`GIT_INDEX_FILE`) inside the repo's own git
 * dir, so the user's staging area is never touched and no other user on the
 * machine can swap it, and a commit no branch points at, so history is never
 * touched either.
 *
 * @returns No ref and no sha when the tree matches `HEAD` or the snapshot was
 *   refused; a sha but no ref when the push failed.
 */
export function snapshot(
  root: string,
  taskId: string,
  untracked: boolean = PUSH_WIP_UNTRACKED,
): Wip {
  const index = resolve(
    root,
    git(root, ["rev-parse", "--git-path", `lanework-wip-${process.pid}.index`]),
  );
  try {
    const env = { GIT_INDEX_FILE: index };
    git(root, ["read-tree", "HEAD"], env);
    git(root, ["add", untracked ? "-A" : "-u"], env);
    const tree = git(root, ["write-tree"], env);
    if (tree === git(root, ["rev-parse", "HEAD^{tree}"])) {
      return { wipRef: null, wipSha: null };
    }
    let refused: string | null;
    try {
      refused = refusal(root, env);
    } catch (error) {
      refused = `it could not be checked for secrets (${String(error)})`;
    }
    if (refused) {
      log(`wip for ${taskId} not pushed: ${refused}`);
      return { wipRef: null, wipSha: null };
    }
    const sha = git(
      root,
      ["commit-tree", tree, "-p", "HEAD", "-m", `lanework wip ${taskId}`],
      {
        GIT_AUTHOR_NAME: "lanework checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@lanework.dev",
        GIT_COMMITTER_NAME: "lanework checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@lanework.dev",
      },
    );
    const ref = `refs/lanework/wip/${taskId}`;
    try {
      git(root, [
        "push",
        "--quiet",
        "--force",
        "--no-verify",
        "origin",
        `${sha}:${ref}`,
      ]);
      return { wipRef: ref, wipSha: sha };
    } catch (error) {
      log(`push of ${ref} failed: ${String(error)}`);
      return { wipRef: null, wipSha: sha };
    }
  } finally {
    rmSync(index, { force: true });
  }
}

// ── The worker ──────────────────────────────────────────────────────────────

type HookInput = {
  session_id?: string;
  /** Codex sends null when it has no rollout file to point at. */
  transcript_path?: string | null;
  cwd?: string;
  /** Codex only: the turn's final answer, no transcript needed. */
  last_assistant_message?: string | null;
};

type Wip = { wipRef: string | null; wipSha: string | null };
type SessionState = {
  at: number;
  /** The working tree the last checkpoint described. */
  code: string;
  /**
   * The tree the remote WIP ref holds (or a clean tree).
   *
   * Null if a push failed.
   */
  pushedCode: string | null;
  wip: Wip;
  /** The card it went to: what Settings shows as "last checkpoint". */
  taskId: string;
};

export function buildBody(
  d: Digest,
  extra: {
    host: string;
    session: string | null;
    git: Partial<CheckpointGit>;
  },
): CheckpointRequest {
  const heading = d.replyIsPrevious
    ? `${AGENT_NAME}'s last message, from the turn BEFORE the request below (it stopped before replying to that one):`
    : `${AGENT_NAME}'s last message before it stopped:`;
  const summary = d.lastReply
    ? `${heading}\n\n${clip(redact(d.lastReply), 5000)}`
    : `${AGENT_NAME} stopped before writing any reply in this session.`;
  return {
    summary,
    request: d.request ? clip(redact(d.request), 2000) : null,
    nextStep: null,
    files: d.files,
    commands: d.commands.map((c) => ({ ...c, command: redact(c.command) })),
    host: extra.host,
    session: extra.session,
    git: extra.git,
  };
}

async function work(inputFile: string): Promise<void> {
  const input = readJson<HookInput>(inputFile, {});
  rmSync(inputFile, { force: true });
  if (AGENT === "opencode") return workOpencode(input);
  if (!input.cwd) return;
  const transcriptPath =
    input.transcript_path ||
    (AGENT === "codex" ? findCodexRollout(input.session_id) : null);
  if (!transcriptPath) return;

  const root = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  const origin = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !origin) return;
  // Never the raw URL: it can carry a token (FE-78/D2).
  const remote = stripUserinfo(origin);

  const transcript = readFileSync(transcriptPath, "utf8");
  const d =
    AGENT === "codex"
      ? digestCodex(transcript, root, input.last_assistant_message ?? null)
      : digest(transcript, root);
  if (!d.taskId) {
    log(`session ${input.session_id}: no card in the transcript; nothing sent`);
    return;
  }

  // A repo whose board is on this machine's local board writes there and
  // needs no credential (FE-52/D9). Any trouble opening it falls back to the
  // cloud.
  let local: LocalBoard | null = null;
  try {
    local = localBoardFor(remote);
  } catch (error) {
    log(`local board unavailable: ${String(error)}`);
  }
  try {
    await checkpointTo(local, { ...d, taskId: d.taskId }, input, root, remote);
  } finally {
    local?.store.close();
  }
}

/** The worker for an OpenCode turn: its session read from `opencode.db`. */
async function workOpencode(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  const session = readOpencodeSession(input.session_id);
  if (!session) {
    log(`opencode session ${input.session_id}: not found; nothing sent`);
    return;
  }
  const cwd = input.cwd || session.directory;
  if (!cwd) return;
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  const origin = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !origin) return;
  // Never the raw URL: it can carry a token (FE-78/D2).
  const remote = stripUserinfo(origin);
  const d = digestOpencode(session.messages, root);
  if (!d.taskId) {
    log(`session ${input.session_id}: no card in the transcript; nothing sent`);
    return;
  }
  let local: LocalBoard | null = null;
  try {
    local = localBoardFor(remote);
  } catch (error) {
    log(`local board unavailable: ${String(error)}`);
  }
  try {
    await checkpointTo(local, { ...d, taskId: d.taskId }, input, root, remote);
  } finally {
    local?.store.close();
  }
}

async function checkpointTo(
  local: LocalBoard | null,
  d: Digest & { taskId: string },
  input: HookInput,
  root: string,
  remote: string,
): Promise<void> {
  const secret = local ? null : readSecret();
  if (!local && !secret) {
    log(
      "no credential; turn the hook on in the Lanework app (Settings → Harness)",
    );
    return;
  }

  // Inside a minute of the last checkpoint, only a change to the code earns
  // a new one (BE-17/D10). `code` is what the working tree looks like now.
  const head = tryGit(root, ["rev-parse", "HEAD"]);
  const status = tryGit(root, ["status", "--porcelain"]) ?? "";
  const diff = tryGit(root, ["diff", "HEAD"]) ?? "";
  const code = sha256([d.taskId, head, status, sha256(diff)].join("\0"));
  const stateFile = join(
    STATE_DIR,
    `session-${sha256(input.session_id ?? "")}.json`,
  );
  const last = readJson<SessionState | null>(stateFile, null);
  if (last && last.code === code && Date.now() - last.at < THIN_MS) return;

  const boardId = local ? null : await boardFor(remote, secret as string);
  if (!local && !boardId) return;

  // Push only when opted in (FE-28/D3), and only when the tree moved since
  // the last push that landed; otherwise the remote ref already holds it.
  const pushed = last?.pushedCode === code ? last.wip : null;
  const wip: Wip = PUSH_WIP
    ? (pushed ?? snapshot(root, d.taskId))
    : { wipRef: null, wipSha: null };
  const body = buildBody(d, {
    host: hostname(),
    session: input.session_id ?? null,
    git: {
      branch: tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head,
      wipRef: wip.wipRef,
      wipSha: wip.wipSha,
      diffStat:
        clip(tryGit(root, ["diff", "HEAD", "--stat"]) ?? "", 3000) || null,
    },
  });

  if (local) {
    try {
      writeLocalCheckpoint(local, d.taskId, body, AGENT);
    } catch (error) {
      log(`local checkpoint for ${d.taskId}: ${String(error)}`);
      return;
    }
  } else {
    const res = await http(paths.itemCheckpoints(boardId as string, d.taskId), {
      method: "POST",
      secret: secret as string,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // The board found for this repo is gone, or no longer this machine's:
      // look it up again next turn (FE-78/D5).
      if ([403, 404, 409].includes(res.status))
        evictBoard(remote, secret as string);
      log(
        `checkpoint for ${d.taskId}: ${res.status} ${clip(await res.text(), 300)}`,
      );
      return;
    }
  }
  const state: SessionState = {
    at: Date.now(),
    code,
    pushedCode: wip.wipRef || !wip.wipSha ? code : null,
    wip,
    taskId: d.taskId,
  };
  writeJson(stateFile, state);
}

// ── Setup ───────────────────────────────────────────────────────────────────

/**
 * Enrol this machine for the hook and keep its credential.
 *
 * The credential goes wherever `credential.ts` keeps it for this install:
 * the Keychain on macOS, a 0600 file elsewhere.
 */
async function setup(token: string | undefined): Promise<void> {
  if (!token?.startsWith(TOKEN_PREFIXES.registration)) {
    console.error(
      `usage: bun apps/desktop/electron/hook/lanework-checkpoint.ts setup <lw_reg_…>\n` +
        `Mint the token at ${API}/setup ("Create registration token").`,
    );
    process.exit(1);
  }
  const res = await http(paths.machinesRegister(), {
    method: "POST",
    body: JSON.stringify({
      token,
      name: `${hostname()} (checkpoint hook)`,
      hostname: hostname(),
      os: platform(),
      arch: arch(),
    } satisfies MachineRegisterRequest),
  });
  if (!res.ok) {
    console.error(`registration failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { machineId, secret } = (await res.json()) as MachineRegisterResponse;
  // Whatever answered is not trusted to hand back something safe to store
  // (FE-78/D1).
  if (!isMachineSecret(secret)) {
    console.error("registration failed: the server sent no valid credential");
    process.exit(1);
  }
  writeSecret(API, secret);
  if (readSecret() !== secret) {
    console.error("the credential could not be read back");
    process.exit(1);
  }
  console.log(
    `enrolled as machine ${machineId}; credential saved to ${credentialLocation(API)}. Revoke it at ${API}/setup.`,
  );
}

// ── Entry ───────────────────────────────────────────────────────────────────

/** This file, however it was started: bun on the source, Node on the bundle. */
const SELF = process.argv[1] ?? "";

async function main(): Promise<void> {
  const [mode, arg, value] = ARGS.positional;
  // The hook proper hands off to a worker, which says it once per turn.
  if (API_REFUSED && mode) {
    // Never sent a credential to it; said where someone will look.
    const note = `refused API ${stripUserinfo(API_ASKED)}: only https, or http on 127.0.0.1, ::1 or localhost; using ${API}`;
    log(note);
    if (mode !== "worker" && mode !== "mcp") console.error(note);
  }
  if (mode === "setup") return setup(arg);
  // `lanework mcp`, the offline board's MCP server on stdio. It comes before
  // anything that could print: stdout is the protocol from here on.
  if (mode === "mcp") {
    try {
      await mcp();
    } catch (error) {
      process.stderr.write(
        `lanework mcp: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  // The plugin's `lanework` command.
  try {
    if (mode === "login")
      return await login(
        API,
        ARGS.flags.has("device"),
        ARGS.flags.has("force"),
        STATE_DIR,
      );
    if (mode === "login-wait" && arg)
      return await waitForDeviceLogin(arg, STATE_DIR);
    if (mode === "logout") return await logout(API);
    if (mode === "status")
      return await status(API, STATE_DIR, desktopHookInstalled());
    if (mode === "config") return config(arg, value);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (mode === "worker" && arg) {
    try {
      await work(arg);
    } catch (error) {
      log(`worker failed: ${String(error)}`);
    }
    return;
  }

  // The hook proper: hand stdin to a detached worker and get out of the way.
  // INF-03/D8: the plugin's copy stands down when the desktop app's hook is
  // installed, or every turn would be checkpointed twice.
  if (ARGS.flags.has("plugin") && desktopHookInstalled()) return;
  try {
    const stdin = readFileSync(0, "utf8");
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const file = join(STATE_DIR, `input-${process.pid}-${Date.now()}.json`);
    writeFileSync(file, stdin, { mode: 0o600 });
    // NOTE: The same flags travel to the worker, and so does the environment,
    // `ELECTRON_RUN_AS_NODE` included, or the worker would start as an app.
    const flags = process.argv
      .slice(2)
      .filter((a) => !ARGS.positional.includes(a));
    spawn(process.execPath, [SELF, ...flags, "worker", file], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (error) {
    log(`hook failed: ${String(error)}`);
  }
}

// Imported (by a test) rather than run: do nothing.
if (basename(SELF).startsWith("lanework-checkpoint")) void main();
