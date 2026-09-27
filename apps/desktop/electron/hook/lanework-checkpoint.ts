// Claude Code Stop hook: leave a checkpoint on the lanework card this session
// is working, so another agent (Codex, or Claude in the cloud) can resume it
// once this one runs out of quota (BE-17).
//
// ⚠️ Installed by the DESKTOP APP (Settings → Agents, FE-28), which bundles
// this file to `dist/electron/hook/lanework-checkpoint.cjs`, writes it into
// `~/.claude/settings.json` and runs it under Electron's own Node
// (`ELECTRON_RUN_AS_NODE=1`) — the people using it have no bun. So: Node APIs
// only, no top-level await, no `import.meta`. It still runs under bun for
// development, and without the app:
//
//   bun apps/desktop/electron/hook/lanework-checkpoint.ts setup <lw_reg_…>
//
// Flags, set by whoever installs it: `--api <url>` (default
// https://api.lanework.dev) and `--push-wip`, the opt-in (FE-28/D3) to push the
// uncommitted tree to `refs/lanework/wip/<task-id>`.
//
// ⚠️ Costs no model quota: it reads the transcript file Claude Code already
// wrote, and nothing here calls a model. That is the point — when the quota runs
// out mid-task, the last completed turn is still on the card.
//
// ⚠️ Never in the way. The hook proper only copies stdin to a temp file and
// spawns a detached worker, so a slow `git push` never holds up the next
// prompt; every failure is logged to ~/.cache/lanework/checkpoint/hook.log and
// the exit code is always 0.
//
// ⚠️ Redaction happens HERE, before anything leaves the machine (BE-17). The
// server caps size but cannot tell a secret from prose.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, hostname, platform, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

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
const API = (
  (typeof ARGS.flags.get("api") === "string"
    ? (ARGS.flags.get("api") as string)
    : "") ||
  process.env.LANEWORK_API_URL ||
  "https://api.lanework.dev"
).replace(/\/$/, "");
/**
 * Settings the app changes without touching the hook's command (FE-29/D3):
 * Codex approves a hook by the hash of its command, so a switch flipped in
 * Settings must not change the command it approved.
 */
function hookConfig(): { pushWip?: boolean } {
  const file = process.env.LANEWORK_HOOK_CONFIG;
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { pushWip?: boolean };
  } catch {
    return {};
  }
}

/** FE-28/D3: pushing unfinished code to the remote is opt-in. */
const PUSH_WIP = ARGS.flags.has("push-wip") || hookConfig().pushWip === true;
/** Which CLI ran this turn — `claude-code` or `codex` (FE-29). */
const AGENT = ARGS.flags.get("agent") === "codex" ? "codex" : "claude-code";
const AGENT_NAME = AGENT === "codex" ? "Codex" : "Claude Code";
/** Keychain item holding this machine's credential (BE-17/D6). */
const KEYCHAIN_SERVICE = "dev.lanework.checkpoint-hook";
const STATE_DIR = join(homedir(), ".cache", "lanework", "checkpoint");
const LOG = join(STATE_DIR, "hook.log");
/** BE-17/D10: an unchanged turn inside this window writes nothing. */
const THIN_MS = 60_000;
const PUSH_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

// ── Small utilities ─────────────────────────────────────────────────────────

function log(message: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (existsSync(LOG) && statSync(LOG).size > 512 * 1024) rmSync(LOG);
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
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

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * Strip anything that looks like a credential.
 *
 * ⚠️ Deliberately greedy: a false positive costs a word in a summary, a false
 * negative puts a key on a server. Exported for the hook's own test.
 */
export function redact(input: string): string {
  return (
    input
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        "[REDACTED private key]",
      )
      // lanework's own tokens, then the common vendors'.
      .replace(/\blw_(?:reg|mch|dev|code)_[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(
        /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
        "[REDACTED]",
      )
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
      .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
      .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED]")
      .replace(
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
        "[REDACTED jwt]",
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]")
      // `user:password@host` in URLs.
      .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
        "$1[REDACTED]@",
      )
      // KEY=value / "secret": "value" style assignments.
      .replace(
        /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|token|credential|private[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
        "$1$2[REDACTED]",
      )
  );
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

// A task id as boards mint them by default: `BE-17`, `FE-09`, `INF-01`.
const TASK_ID = /\b[A-Z]{2,5}-\d{1,5}\b/g;
// Things that look like one and are not.
const NOT_TASK_ID = /^(?:UTF|SHA|ISO|RFC|HTTP|TLS|CVE|MD|AES|RSA|ES|ECMA)-/;

/**
 * Condense a transcript into what the next agent needs (BE-17/D11).
 *
 * ⚠️ The card is the one this session TALKED TO the board about — the last
 * `card` a lanework tool was called with, or the task id one of them returned.
 * Only when there is none does a task id the user typed count; a stray `UTF-8`
 * then fails the server's lookup, which is a 404 and a log line, not a baton on
 * the wrong card.
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
        // ⚠️ The previous turn's reply is kept until this turn writes one:
        // a worker that runs mid-turn (or a turn that ends in tool calls)
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
            const rel = path.startsWith(root) ? relative(root, path) : path;
            if (!rel.startsWith("..")) {
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

// ── Codex (FE-29) ───────────────────────────────────────────────────────────

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
 * The rollout file for a Codex session when the hook was not told one.
 *
 * ⚠️ Newest days first, and only the last few: a session that is still
 * running wrote to one of them today or yesterday. Named
 * `rollout-<time>-<session id>.jsonl`.
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
 * Condense a Codex rollout the way `digest` does a Claude transcript.
 *
 * ⚠️ Read from `item_completed` events — `UserMessage`, `AgentMessage`,
 * `CommandExecution` (with its exit code), `FileChange`, `McpToolCall` —
 * which Codex writes for every item whatever mode it ran tools in. Only a
 * rollout with none of them (an older Codex) falls back to reading the
 * `exec` scripts of "code mode" by pattern. The final answer comes from the
 * hook's stdin (`last_assistant_message`) when Codex sends it, which is exact.
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
    const trimmed = path.trim().replace(/^file:\/\//, "");
    const rel = trimmed.startsWith(root) ? relative(root, trimmed) : trimmed;
    if (!rel || rel.startsWith("..")) return;
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

// ── Credential and board ────────────────────────────────────────────────────

function readSecret(): string | null {
  // A file instead of the Keychain, for tests and for machines without one.
  // The desktop app honours the same variable when it writes the credential.
  const file = process.env.LANEWORK_HOOK_SECRET_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", API, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

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
      "x-lanework-agent": AGENT,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

async function boardFor(
  remote: string,
  secret: string,
): Promise<string | null> {
  const cacheFile = join(STATE_DIR, "boards.json");
  const cache = readJson<Record<string, string>>(cacheFile, {});
  if (cache[remote]) return cache[remote];
  const res = await http(`/v1/boards?repo=${encodeURIComponent(remote)}`, {
    secret,
  });
  if (!res.ok) {
    log(`board lookup ${res.status} for ${remote}`);
    return null;
  }
  const { boards } = (await res.json()) as {
    boards: { workspaceId: string }[];
  };
  // Same rule as the MCP server's: exactly one, or none at all.
  if (boards.length !== 1) {
    log(`${boards.length} boards linked to ${remote}; not guessing`);
    return null;
  }
  const id = boards[0]?.workspaceId ?? null;
  if (id) writeJson(cacheFile, { ...cache, [remote]: id });
  return id;
}

// ── Git: where the code is (BE-17/D1) ───────────────────────────────────────

/**
 * Snapshot the working tree — tracked changes AND untracked files that are not
 * ignored — as a commit on no branch, and push it to `refs/lanework/wip/<id>`.
 *
 * ⚠️ A private index (`GIT_INDEX_FILE`), so the user's staging area is never
 * touched, and a commit no branch points at, so history is never touched
 * either. The ref is force-pushed: it is a baton, only the latest matters.
 */
export function snapshot(root: string, taskId: string): Wip {
  const index = join(tmpdir(), `lanework-wip-${process.pid}.index`);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(root, ["read-tree", "HEAD"], env);
    git(root, ["add", "-A"], env);
    const tree = git(root, ["write-tree"], env);
    if (tree === git(root, ["rev-parse", "HEAD^{tree}"])) {
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
  /** Codex only (FE-29): the turn's final answer, no transcript needed. */
  last_assistant_message?: string | null;
};

type Wip = { wipRef: string | null; wipSha: string | null };
type SessionState = {
  at: number;
  /** The working tree the last checkpoint described. */
  code: string;
  /** The tree the remote WIP ref holds (or a clean tree), null if a push failed. */
  pushedCode: string | null;
  wip: Wip;
  /** The card it went to — what Settings → Agents shows as "last checkpoint". */
  taskId: string;
};

export function buildBody(
  d: Digest,
  extra: {
    host: string;
    session: string | null;
    git: Record<string, string | null>;
  },
) {
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
  if (!input.cwd) return;
  const transcriptPath =
    input.transcript_path ||
    (AGENT === "codex" ? findCodexRollout(input.session_id) : null);
  if (!transcriptPath) return;

  const root = tryGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  const remote = root && tryGit(root, ["remote", "get-url", "origin"]);
  if (!root || !remote) return;

  const transcript = readFileSync(transcriptPath, "utf8");
  const d =
    AGENT === "codex"
      ? digestCodex(transcript, root, input.last_assistant_message ?? null)
      : digest(transcript, root);
  if (!d.taskId) {
    log(`session ${input.session_id}: no card in the transcript; nothing sent`);
    return;
  }

  const secret = readSecret();
  if (!secret) {
    log(
      "no credential; turn the hook on in the Lanework app (Settings → Agents)",
    );
    return;
  }

  // D10: inside a minute of the last checkpoint, only a change to the code
  // earns a new one. `code` is what the working tree looks like right now.
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

  const boardId = await boardFor(remote, secret);
  if (!boardId) return;

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

  const res = await http(
    `/v1/boards/${boardId}/items/${encodeURIComponent(d.taskId)}/checkpoints`,
    { method: "POST", secret, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    log(
      `checkpoint for ${d.taskId}: ${res.status} ${clip(await res.text(), 300)}`,
    );
    return;
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
 * Enrol this machine for the hook and keep its credential in the Keychain.
 *
 * ⚠️ The secret reaches `security` on STDIN (`security -i`), never in argv,
 * where any process on the machine could read it from the process list.
 */
async function setup(token: string | undefined): Promise<void> {
  if (!token?.startsWith("lw_reg_")) {
    console.error(
      `usage: bun apps/desktop/electron/hook/lanework-checkpoint.ts setup <lw_reg_…>\n` +
        `Mint the token at ${API}/setup ("Create registration token").`,
    );
    process.exit(1);
  }
  const res = await http("/v1/machines/register", {
    method: "POST",
    body: JSON.stringify({
      token,
      name: `${hostname()} · checkpoint hook`,
      hostname: hostname(),
      os: platform(),
      arch: arch(),
    }),
  });
  if (!res.ok) {
    console.error(`registration failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { machineId, secret } = (await res.json()) as {
    machineId: string;
    secret: string;
  };
  execFileSync("security", ["-i"], {
    input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${API}" -w "${secret}"\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (readSecret() !== secret) {
    console.error("the credential could not be read back from the Keychain");
    process.exit(1);
  }
  console.log(
    `enrolled as machine ${machineId}; credential saved to the Keychain ` +
      `(service ${KEYCHAIN_SERVICE}). Revoke it at ${API}/setup.`,
  );
}

// ── Entry ───────────────────────────────────────────────────────────────────

/** This file, however it was started: bun on the source, Node on the bundle. */
const SELF = process.argv[1] ?? "";

async function main(): Promise<void> {
  const [mode, arg] = ARGS.positional;
  if (mode === "setup") return setup(arg);
  if (mode === "worker" && arg) {
    try {
      await work(arg);
    } catch (error) {
      log(`worker failed: ${String(error)}`);
    }
    return;
  }

  // The hook proper: hand stdin to a detached worker and get out of the way.
  try {
    const stdin = readFileSync(0, "utf8");
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const file = join(STATE_DIR, `input-${process.pid}-${Date.now()}.json`);
    writeFileSync(file, stdin, { mode: 0o600 });
    // ⚠️ The same flags travel to the worker, and so does the environment —
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
