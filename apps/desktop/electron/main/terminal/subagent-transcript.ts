// One sub-agent's transcript, read for the viewer (FE-35): what it was asked,
// the tools it called and what it reported back — a Claude sub-agent, or a
// thread a Codex conversation spawned.
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a spec
// can drive it under plain Node against a fake home folder.
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  isAgentSessionId,
  isClaudeSubagentId,
  SUBAGENT_INPUT_MAX,
  type SubagentStep,
  type SubagentTranscript,
  type TerminalAgent,
} from "../../../shared/terminal";
import {
  claudeProjectDir,
  claudeSubagentWorking,
  codexRole,
  codexRollouts,
  codexWorking,
  type Line,
  lines,
  META_CHUNK,
  readRange,
  STALE_MS,
  tidy,
} from "./agent-sessions";

/** The most of a transcript one read takes (FE-35/D10). */
const SUBAGENT_READ_MAX = 8 * 1024 * 1024;
/** Of a transcript longer than that: its end, for the report and the state. */
const TAIL = 1024 * 1024;
const META_MAX = 64 * 1024;

/** What the viewer asks for, checked. */
interface SubagentRequest {
  workspace: string;
  agent: TerminalAgent;
  conversation: string;
  sub: string;
}

/**
 * The viewer's request off the wire: ids, never a path (FE-35/D10).
 *
 * ⚠️ Each one of the shape its CLI writes and nothing else — a conversation
 * is a UUID, a Claude sub-agent the `<id>` of its file's name, a Codex thread
 * a UUID — so none can be `..`, a separator or an absolute path. The path
 * is built from them by `readSubagentTranscript`, inside the CLI's folder.
 */
export function subagentRequest(args: unknown[]): SubagentRequest {
  if (args.length !== 4)
    throw new Error("A workspace, a conversation and a sub-agent are required");
  const [workspace, agent, conversation, sub] = args;
  if (
    typeof workspace !== "string" ||
    !workspace.trim() ||
    workspace.length > 200
  )
    throw new Error("A valid workspace is required");
  if (agent !== "claude" && agent !== "codex")
    throw new Error("A valid agent is required");
  if (!isAgentSessionId(conversation))
    throw new Error("A valid conversation is required");
  if (
    typeof sub !== "string" ||
    !(agent === "claude" ? isClaudeSubagentId(sub) : isAgentSessionId(sub))
  )
    throw new Error("A valid sub-agent is required");
  return { workspace, agent, conversation, sub };
}

/**
 * A transcript's lines, at most `SUBAGENT_READ_MAX` of it: the whole of one
 * that fits; of one that does not, its start and its last `TAIL` — where
 * the report and the state are — with what lies between left out.
 */
async function readTranscript(
  file: string,
): Promise<{ rows: Line[]; truncated: boolean; fresh: boolean }> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("That sub-agent has no transcript.");
  const fresh = Date.now() - info.mtimeMs <= STALE_MS;
  if (info.size <= SUBAGENT_READ_MAX)
    return {
      rows: lines(await readRange(file, 0, info.size), { head: true }),
      truncated: false,
      fresh,
    };
  const head = lines(await readRange(file, 0, SUBAGENT_READ_MAX - TAIL), {
    head: true,
  });
  const tail = lines(await readRange(file, info.size - TAIL, TAIL), {
    head: false,
  });
  return { rows: [...head, ...tail], truncated: true, fresh };
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** The first line of `text` with something on it. */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? "";
}

/** Its input as the viewer shows it: pretty JSON, cut short. */
function inputText(input: unknown): string {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = JSON.stringify(input ?? {}, null, 2) ?? "";
    } catch {
      text = "";
    }
  }
  return text.length > SUBAGENT_INPUT_MAX
    ? `${text.slice(0, SUBAGENT_INPUT_MAX - 1)}…`
    : text;
}

/** A path as the step shows it: from the project's folder, when it is in it. */
function shown(path: unknown, folder: string): string {
  if (typeof path !== "string") return "";
  if (!isAbsolute(path)) return path;
  const inside = relative(folder, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside)
    ? inside
    : path;
}

/** The first string an input holds — what a tool not known here was called on. */
function anyString(input: Record<string, unknown>): string {
  for (const value of Object.values(input))
    if (typeof value === "string" && value.trim()) return firstLine(value);
  return "";
}

/**
 * What a Claude tool call was made on, in one line (FE-35/D3): the path for
 * a file tool, the pattern for a search, the first line of a command.
 */
export function claudeStepSummary(
  tool: string,
  input: Record<string, unknown>,
  folder: string,
): string {
  const path = shown(input.file_path ?? input.notebook_path, folder);
  switch (tool) {
    case "Read": {
      const offset = typeof input.offset === "number" ? input.offset : null;
      const limit = typeof input.limit === "number" ? input.limit : null;
      const start = offset ?? 1;
      const range =
        limit !== null
          ? `:${start}-${start + limit - 1}`
          : offset !== null
            ? `:${offset}`
            : "";
      return `${path}${range}`;
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return path;
    case "Grep":
    case "Glob": {
      const where = shown(input.path, folder);
      const glob = typeof input.glob === "string" ? input.glob : "";
      return [
        typeof input.pattern === "string" ? `"${input.pattern}"` : "",
        glob,
        where,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "Bash":
      return typeof input.command === "string" ? firstLine(input.command) : "";
    case "WebFetch":
      return typeof input.url === "string" ? input.url : "";
    case "WebSearch":
    case "ToolSearch":
      return typeof input.query === "string" ? input.query : "";
    case "Agent":
    case "Task":
      return typeof input.description === "string" ? input.description : "";
    case "Skill":
      return typeof input.skill === "string" ? input.skill : "";
    case "TodoWrite":
      return Array.isArray(input.todos)
        ? `${input.todos.length} item${input.todos.length === 1 ? "" : "s"}`
        : "";
    default:
      return anyString(input);
  }
}

/** A user turn's text: the string it is, or its text parts. */
function claudeText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = (content as { type?: unknown; text?: unknown }[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * What a sub-agent was told, out of the turn that told it.
 *
 * ⚠️ A fork's is wrapped: Claude puts its own rules for a fork in front of
 * the directive (`<fork-boilerplate>…</fork-boilerplate>`, then `Your
 * directive:`). The directive is what it was asked.
 */
function directive(text: string): string {
  return text
    .replace(/<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>/, "")
    .trim()
    .replace(/^Your directive:\s*/, "")
    .trim();
}

/** The tool Claude's sub-agents hand their report back with (newer CLIs). */
const HANDBACK = "SubagentHandback";

interface ClaudeMeta {
  agentType?: unknown;
  description?: unknown;
  model?: unknown;
}

/**
 * A Claude sub-agent's transcript, from its lines and its `.meta.json`.
 *
 * ⚠️ A FORK's transcript opens with a `fork-context-ref` — the parent's
 * history it inherited is NOT copied in — followed by the parent's own call
 * that spawned it. Neither is the fork's: its prompt is the first user turn
 * after the ref, and its steps start after that turn.
 *
 * ⚠️ Its report is what it handed back through `SubagentHandback` when it
 * did; otherwise its last answer — the text after the last thing it was
 * told or shown — once it is done.
 */
function claudeSubagentTranscript(
  rows: Line[],
  meta: ClaudeMeta | null,
  {
    folder,
    fresh,
    truncated,
  }: { folder: string; fresh: boolean; truncated: boolean },
): SubagentTranscript {
  const ref = rows.findIndex((line) => line.type === "fork-context-ref");
  let at = ref + 1;
  let prompt: string | null = null;
  for (; at < rows.length; at++) {
    const line = rows[at] as Line;
    if (line.type !== "user" || line.isMeta) continue;
    const text = claudeText((line.message as { content?: unknown })?.content);
    const told = text === null ? "" : directive(text);
    if (told) {
      prompt = told;
      break;
    }
  }
  // No prompt found: every line is its own.
  const own = prompt === null ? rows.slice(ref + 1) : rows.slice(at);

  const steps: (SubagentStep & { id: string | null })[] = [];
  const failed = new Set<string>();
  let handback: string | null = null;
  let model: string | null = null;
  /** Where the newest thing it was told or shown is: its answer is after. */
  let lastTold = -1;
  for (const [index, line] of own.entries()) {
    const content = (line.message as { content?: unknown } | undefined)
      ?.content;
    if (line.type === "assistant") {
      const named = (line.message as { model?: unknown }).model;
      if (typeof named === "string" && named && !named.startsWith("<"))
        model = named;
      if (!Array.isArray(content)) continue;
      for (const part of content as Record<string, unknown>[]) {
        if (part?.type !== "tool_use" || typeof part.name !== "string")
          continue;
        const input =
          part.input && typeof part.input === "object"
            ? (part.input as Record<string, unknown>)
            : {};
        if (part.name === HANDBACK) {
          handback = str(input.message) ?? handback;
          continue;
        }
        steps.push({
          id: typeof part.id === "string" ? part.id : null,
          tool: part.name,
          summary: tidy(claudeStepSummary(part.name, input, folder)),
          input: inputText(input),
          error: false,
        });
      }
      continue;
    }
    if (line.type !== "user" || line.isMeta) continue;
    lastTold = index;
    if (!Array.isArray(content)) continue;
    for (const part of content as Record<string, unknown>[])
      if (
        part?.type === "tool_result" &&
        part.is_error === true &&
        typeof part.tool_use_id === "string"
      )
        failed.add(part.tool_use_id);
  }

  const working = fresh && claudeSubagentWorking(rows);
  let report: string | null = handback;
  if (report === null && !working) {
    const answer = own
      .slice(lastTold + 1)
      .filter((line) => line.type === "assistant")
      .flatMap((line) => {
        const content = (line.message as { content?: unknown } | undefined)
          ?.content;
        return Array.isArray(content)
          ? (content as { type?: unknown; text?: unknown }[])
              .filter(
                (part) =>
                  part?.type === "text" && typeof part.text === "string",
              )
              .map((part) => (part.text as string).trim())
          : [];
      })
      .filter(Boolean);
    report = answer.length > 0 ? answer.join("\n\n") : null;
  }

  const stamps = own
    .map((line) => line.timestamp)
    .filter((stamp): stamp is string => typeof stamp === "string");
  const described = str(meta?.description);
  const metaModel = str(meta?.model);
  return {
    title: described ? tidy(described) : prompt ? tidy(prompt) : "Sub-agent",
    type: str(meta?.agentType),
    model: model ?? (metaModel && metaModel !== "inherit" ? metaModel : null),
    startedAt: stamps[0] ?? null,
    endedAt: stamps.at(-1) ?? null,
    working,
    prompt,
    steps: steps.map(({ id, ...step }) => ({
      ...step,
      error: id !== null && failed.has(id),
    })),
    report,
    truncated,
  };
}

/** `cmd: "…"` in the script Codex's `exec` tool runs: what it ran. */
const CODEX_CMD = /\bcmd"?\s*:\s*("(?:[^"\\\n]|\\.)*")/;
/** `tools.<name>(` in that script: what it called, when it ran no command. */
const CODEX_TOOL = /\btools\.([A-Za-z0-9_]+)\s*\(/;

/** The files an `apply_patch` touches, by its `*** … File:` lines. */
function patched(patch: string, folder: string): string {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => shown(match[1]?.trim(), folder))
    .join(", ");
}

/** What a Codex tool call was made on, in one line (FE-35/D3). */
function codexStepSummary(
  tool: string,
  input: unknown,
  folder: string,
): string {
  if (typeof input === "string") {
    if (tool === "apply_patch") return patched(input, folder);
    const cmd = CODEX_CMD.exec(input)?.[1];
    if (cmd) {
      try {
        return firstLine(JSON.parse(cmd) as string);
      } catch {
        // Not a string after all: what it called, below.
      }
    }
    const called = CODEX_TOOL.exec(input)?.[1];
    return called ?? firstLine(input);
  }
  const args = (input ?? {}) as Record<string, unknown>;
  if (typeof args.cmd === "string") return firstLine(args.cmd);
  if (Array.isArray(args.command))
    return args.command.filter((part) => typeof part === "string").join(" ");
  if (typeof args.command === "string") return firstLine(args.command);
  if (tool === "apply_patch" && typeof args.input === "string")
    return patched(args.input, folder);
  if (typeof args.task_name === "string") return args.task_name;
  return anyString(args);
}

/** Whether a Codex tool's output says it failed. */
function codexFailed(output: unknown): boolean {
  const text =
    typeof output === "string"
      ? output
      : Array.isArray(output)
        ? ((output as { text?: unknown }[]).find(
            (part) => typeof part?.text === "string",
          )?.text as string | undefined)
        : undefined;
  if (!text) return false;
  // The `exec` tool: its script threw, or a call in it did.
  if (/^Script failed\b/.test(text)) return true;
  // Older CLIs: the shell's own output, as JSON with its exit code.
  try {
    const parsed = JSON.parse(text) as {
      metadata?: { exit_code?: unknown };
    } | null;
    const code = parsed?.metadata?.exit_code;
    return typeof code === "number" && code !== 0;
  } catch {
    return false;
  }
}

/** The plain text of a Codex message's parts. */
function codexText(content: unknown, kind: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts = (content as { type?: unknown; text?: unknown }[])
    .filter((part) => part?.type === kind && typeof part.text === "string")
    .map((part) => part.text as string);
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * What a Codex thread was told: the readable payload of the task its
 * spawner sent it, or the first thing typed into it.
 *
 * ⚠️ Often none: Codex sends a spawned thread its task ENCRYPTED, in its own
 * rollout and in its spawner's — then the viewer says so, rather than show
 * the envelope.
 */
function codexTold(rows: Line[]): string | null {
  for (const line of rows) {
    const payload = line.payload as Record<string, unknown> | null;
    if (line.type !== "response_item" || !payload) continue;
    if (payload.type === "agent_message") {
      const text = codexText(payload.content, "input_text");
      const told = text?.split(/^Payload:\n?/m)[1]?.trim();
      if (told) return told;
      continue;
    }
    if (payload.type !== "message" || payload.role !== "user") continue;
    for (const part of (payload.content ?? []) as {
      type?: unknown;
      text?: unknown;
    }[]) {
      if (part?.type !== "input_text" || typeof part.text !== "string")
        continue;
      const text = part.text.trim();
      if (text && !text.startsWith("<") && !text.startsWith("# AGENTS.md"))
        return text;
    }
  }
  return null;
}

/**
 * A thread a Codex conversation spawned, from its rollout's lines (FE-35/D7):
 * its tool calls are `function_call` and `custom_tool_call` items, each
 * answered by an output with the same `call_id`.
 */
function codexSubagentTranscript(
  rows: Line[],
  {
    folder,
    fresh,
    truncated,
  }: { folder: string; fresh: boolean; truncated: boolean },
): SubagentTranscript {
  const meta = (rows.find((line) => line.type === "session_meta")?.payload ??
    {}) as Record<string, unknown>;
  const role = codexRole(meta);
  const steps: (SubagentStep & { id: string | null })[] = [];
  const failed = new Set<string>();
  let model: string | null = null;
  let finished: string | null = null;
  let answer: string | null = null;
  for (const line of rows) {
    const payload = line.payload as Record<string, unknown> | null;
    if (!payload) continue;
    if (line.type === "turn_context") {
      model = str(payload.model) ?? model;
      continue;
    }
    if (line.type === "event_msg") {
      if (payload.type === "task_complete")
        finished = str(payload.last_agent_message) ?? finished;
      continue;
    }
    if (line.type !== "response_item") continue;
    const call = typeof payload.call_id === "string" ? payload.call_id : null;
    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call"
    ) {
      const tool = str(payload.name) ?? "tool";
      let input: unknown = payload.input;
      if (payload.type === "function_call") {
        try {
          input = JSON.parse(String(payload.arguments ?? "{}"));
        } catch {
          input = payload.arguments;
        }
      }
      steps.push({
        id: call,
        tool,
        summary: tidy(codexStepSummary(tool, input, folder)),
        input: inputText(input),
        error: false,
      });
    } else if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output"
    ) {
      if (call && codexFailed(payload.output)) failed.add(call);
    } else if (payload.type === "message" && payload.role === "assistant") {
      answer = str(codexText(payload.content, "output_text")) ?? answer;
    }
  }
  const working = fresh && codexWorking(rows);
  const prompt = codexTold(rows);
  const spawned = role.kind === "spawned" ? role : null;
  const stamps = rows
    .map((line) => line.timestamp)
    .filter((stamp): stamp is string => typeof stamp === "string");
  return {
    title:
      [spawned?.nickname, spawned?.task].filter(Boolean).join(": ") ||
      (prompt ? tidy(prompt) : "Sub-agent"),
    type: spawned?.role ?? null,
    model,
    startedAt: str(meta.timestamp) ?? stamps[0] ?? null,
    endedAt: stamps.at(-1) ?? null,
    working,
    prompt,
    steps: steps.map(({ id, ...step }) => ({
      ...step,
      error: id !== null && failed.has(id),
    })),
    report: working ? null : (finished ?? answer),
    truncated,
  };
}

/**
 * Codex rollouts found by thread, kept for the viewer's next read — a
 * working thread is read again on its every write (FE-35/D11).
 */
const codexFiles = new Map<string, string>();

/**
 * The rollout of Codex thread `sub`, if it is one `conversation` spawned in
 * `folder` — by its file's name among the newest rollouts, then by its
 * `session_meta`.
 */
async function codexSubagentFile(
  home: string,
  folder: string,
  conversation: string,
  sub: string,
): Promise<string> {
  const key = `${folder}\0${conversation}\0${sub}`;
  const known = codexFiles.get(key);
  if (known && (await stat(known).catch(() => null))?.isFile()) return known;
  codexFiles.delete(key);
  const files = await codexRollouts(join(home, ".codex", "sessions"));
  for (const file of files) {
    if (!basename(file).endsWith(`-${sub}.jsonl`)) continue;
    const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
    const meta = head.find((line) => line.type === "session_meta")?.payload as
      | Record<string, unknown>
      | undefined;
    if (!meta || meta.id !== sub || meta.cwd !== folder) continue;
    const role = codexRole(meta);
    if (role.kind !== "spawned" || role.root !== conversation) continue;
    codexFiles.set(key, file);
    return file;
  }
  throw new Error("That sub-agent is not one of this conversation's.");
}

/**
 * Sub-agent `sub` of `agent`'s conversation `conversation` in `folder`, read
 * for the viewer (FE-35).
 *
 * ⚠️ The ids are checked again here, and the path is built from them inside
 * the CLI's own folder under `home`: Claude's
 * `projects/<folder>/<conversation>/subagents/agent-<sub>.jsonl`, or a
 * rollout whose own `session_meta` says it is that conversation's thread.
 */
export async function readSubagentTranscript(
  home: string,
  folder: string,
  { agent, conversation, sub }: Omit<SubagentRequest, "workspace">,
): Promise<SubagentTranscript> {
  subagentRequest(["-", agent, conversation, sub]);
  if (agent === "codex") {
    const file = await codexSubagentFile(home, folder, conversation, sub);
    const { rows, ...read } = await readTranscript(file);
    return codexSubagentTranscript(rows, { folder, ...read });
  }
  const dir = join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    conversation,
    "subagents",
  );
  const { rows, ...read } = await readTranscript(
    join(dir, `agent-${sub}.jsonl`),
  ).catch(() => {
    throw new Error("That sub-agent is not one of this conversation's.");
  });
  const meta = await readRange(join(dir, `agent-${sub}.meta.json`), 0, META_MAX)
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  return claudeSubagentTranscript(
    rows,
    meta && typeof meta === "object" ? (meta as ClaudeMeta) : null,
    { folder, ...read },
  );
}
