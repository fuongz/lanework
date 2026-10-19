// A Codex conversation read as a chat: its rollout's lines folded into the
// same turns a Claude transcript gives (`transcript.ts`) — the prompt, then
// the answer's text and its tool calls, per-turn usage.
//
// Codex writes every finished item of a turn as an `event_msg` of type
// `item_completed` — `UserMessage`, `AgentMessage`, `CommandExecution`,
// `FileChange`, `McpToolCall`… — which is what is read here. Older CLIs wrote
// `user_message` / `agent_message` events instead; those are read as text.
//
// ⚠️ Read-only, and nothing here imports Electron: main calls it, and a Node
// script can drive it against a fake home folder.
import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type AssistantTurn,
  type Attachment,
  CONVERSATION_READ_MAX,
  type Conversation,
  type ToolCall,
  type Turn,
  type UserTurn,
} from "../../../shared/conversation";
import { type AgentCard, isAgentSessionId } from "../../../shared/terminal";
import {
  codexRole,
  codexRollouts,
  codexWorking,
  type Line,
  laneworkCard,
  lines,
  META_CHUNK,
  readRange,
  STALE_MS,
  tidy,
} from "../terminal/agent-sessions";
import { cut, inputText } from "./transcript";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** `file:///a/b` → `/a/b`; a plain path as it is. */
function pathOf(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  if (!text.startsWith("file://")) return text;
  try {
    return decodeURIComponent(new URL(text).pathname);
  } catch {
    return null;
  }
}

/** A path as the row shows it: under `folder`, relative to it. */
function shown(path: string, folder: string): string {
  const rel = relative(folder, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** `["/bin/zsh", "-lc", "ls"]` → `ls`; any other shape joined. */
function commandLine(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.filter(
    (part): part is string => typeof part === "string",
  );
  if (parts.length === 3 && /^-l?c$/.test(parts[1] ?? ""))
    return parts[2] ?? "";
  return parts.join(" ");
}

/** A message item's text parts, joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** What a finished tool item reads as, or null for one with nothing to show. */
function toolOf(
  item: Record<string, unknown>,
  folder: string,
  fallback: string,
): ToolCall | null {
  const id = str(item.id) ?? fallback;
  const base = { id, error: false, filePath: null, subagent: null };
  switch (item.type) {
    case "CommandExecution": {
      const command = commandLine(item.command);
      return {
        ...base,
        tool: "exec_command",
        kind: "command",
        summary: tidy(command),
        input: cut(command),
        output: cut(str(item.aggregated_output) ?? ""),
        error:
          item.status === "failed" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0),
      };
    }
    case "FileChange": {
      const changes = record(item.changes);
      const paths = Object.keys(changes);
      const diff = paths
        .map((path) => {
          const change = record(changes[path]);
          const body = str(change.unified_diff) ?? str(change.content) ?? "";
          return `${str(change.type) ?? "update"} ${shown(path, folder)}\n${body}`;
        })
        .join("\n\n");
      return {
        ...base,
        tool: "apply_patch",
        kind: "edit",
        summary: tidy(paths.map((path) => shown(path, folder)).join(", ")),
        input: cut(diff),
        output: cut(
          [str(item.stdout), str(item.stderr)].filter(Boolean).join("\n"),
        ),
        error: item.status === "failed",
        filePath: paths[0] ?? null,
      };
    }
    case "McpToolCall": {
      const server = str(item.server) ?? "mcp";
      const tool = str(item.tool) ?? "tool";
      const result = record(item.result);
      const output =
        textOf(result.content) || (item.error ? inputText(item.error) : "");
      return {
        ...base,
        tool: `mcp__${server}__${tool}`,
        kind: "mcp",
        summary: tidy(`${server} · ${tool}`),
        input: inputText(item.arguments),
        output: cut(output),
        error: item.status === "failed" || Boolean(item.error),
      };
    }
    case "WebSearch": {
      const query = str(item.query) ?? "";
      return {
        ...base,
        tool: "web_search",
        kind: "search",
        summary: tidy(query),
        input: cut(query),
        output: "",
      };
    }
    case "ImageView": {
      const path = pathOf(item.path);
      if (!path) return null;
      return {
        ...base,
        tool: "view_image",
        kind: "read",
        summary: tidy(shown(path, folder)),
        input: cut(path),
        output: "",
        filePath: path,
      };
    }
    case "Extension": {
      // ⚠️ An image generation carries the image itself, base64, in
      // `result`: only its prompt and saved path are read.
      const prompt = str(item.revisedPrompt) ?? str(item.kind) ?? "extension";
      const saved = str(item.savedPath);
      return {
        ...base,
        tool: str(item.kind) ?? "extension",
        kind: "other",
        summary: tidy(prompt),
        input: cut(prompt),
        output: saved ?? "",
        error: item.status === "failed",
        filePath: saved,
      };
    }
    default:
      return null;
  }
}

/** A `UserMessage` item's text and attached images. */
function promptOf(item: Record<string, unknown>): {
  text: string;
  attachments: Attachment[];
} {
  const content = Array.isArray(item.content)
    ? (item.content as Record<string, unknown>[])
    : [];
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string")
      texts.push(part.text);
    else if (part?.type === "local_image" || part?.type === "image") {
      const path = pathOf(part.path);
      attachments.push({
        name: path?.split("/").pop() || `Image #${attachments.length + 1}`,
        mediaType: "image/*",
        path: path && path !== "-" ? path : null,
      });
    }
  }
  return { text: texts.join("\n\n").trim(), attachments };
}

/**
 * The turns of a rollout's lines, in order: a user turn per prompt, and
 * everything after it — text, tool calls folded between two texts — as one
 * assistant turn. Usage is summed from its `token_count` events.
 */
export function buildCodexTurns(rows: readonly Line[], folder: string): Turn[] {
  const turns: Turn[] = [];
  // ⚠️ Newer CLIs write both the item and the old event for one message:
  // the items win wherever there are any.
  const items = rows.some(
    (line) =>
      line.type === "event_msg" &&
      record(line.payload).type === "item_completed",
  );
  let building: AssistantTurn | null = null;
  let usage = { input: 0, output: 0, cached: 0, seen: false };
  let promptAt: number | null = null;
  let model: string | null = null;

  const close = () => {
    if (!building) return;
    if (usage.seen) {
      const from = promptAt;
      const to = building.endedAt ? Date.parse(building.endedAt) : Number.NaN;
      const seconds =
        from !== null && Number.isFinite(to) ? (to - from) / 1000 : 0;
      building.usage = {
        input: usage.input,
        output: usage.output,
        cached: usage.cached,
        cacheHitPct:
          usage.cached > 0
            ? (usage.cached / (usage.cached + usage.input)) * 100
            : null,
        tokPerSec:
          seconds > 0 && usage.output > 0 ? usage.output / seconds : null,
      };
    }
    if (building.blocks.length > 0 || building.usage) turns.push(building);
    building = null;
    usage = { input: 0, output: 0, cached: 0, seen: false };
  };
  const open = (id: string, at: string): AssistantTurn => {
    building ??= {
      role: "assistant",
      id,
      blocks: [],
      model,
      usage: null,
      at,
      endedAt: null,
      open: false,
    };
    return building;
  };
  const prompt = (
    id: string,
    text: string,
    attachments: Attachment[],
    at: string,
  ) => {
    if (!text && attachments.length === 0) return;
    close();
    const sent = Date.parse(at);
    promptAt = Number.isFinite(sent) ? sent : null;
    turns.push({ role: "user", id, text, attachments, at } satisfies UserTurn);
  };
  const say = (id: string, text: string, at: string) => {
    if (!text.trim()) return;
    const turn = open(id, at);
    turn.blocks.push({ type: "text", text });
    turn.endedAt = at;
  };

  for (const [index, line] of rows.entries()) {
    const at = str(line.timestamp) ?? "";
    const payload = record(line.payload);
    if (line.type === "turn_context") {
      model = str(payload.model) ?? model;
      if (building) (building as AssistantTurn).model ??= model;
      continue;
    }
    if (line.type !== "event_msg") continue;
    switch (payload.type) {
      case "item_completed": {
        const item = record(payload.item);
        const id = str(item.id) ?? `i-${index}`;
        if (item.type === "UserMessage") {
          const { text, attachments } = promptOf(item);
          prompt(id, text, attachments, at);
        } else if (item.type === "AgentMessage")
          say(id, textOf(item.content), at);
        else {
          const call = toolOf(item, folder, id);
          if (!call) break;
          const turn = open(id, at);
          const last = turn.blocks.at(-1);
          if (last?.type === "tools") last.calls.push(call);
          else turn.blocks.push({ type: "tools", calls: [call] });
          turn.endedAt = at;
        }
        break;
      }
      case "user_message":
        if (!items) {
          const text = (str(payload.message) ?? "").trim();
          if (!text.startsWith("<")) prompt(`u-${index}`, text, [], at);
        }
        break;
      case "agent_message":
        if (!items) say(`a-${index}`, str(payload.message) ?? "", at);
        break;
      case "token_count": {
        const last = record(record(payload.info).last_token_usage);
        if (!building || !Object.keys(last).length) break;
        const cached = num(last.cached_input_tokens);
        usage = {
          // ⚠️ OpenAI's `input_tokens` counts the cached ones too.
          input: usage.input + Math.max(0, num(last.input_tokens) - cached),
          output: usage.output + num(last.output_tokens),
          cached: usage.cached + cached,
          seen: true,
        };
        break;
      }
      case "task_complete":
      case "turn_aborted":
        if (building) (building as AssistantTurn).endedAt = at;
        break;
    }
  }
  close();
  return turns;
}

/** What a read of a rollout's lines answers, before main adds its own. */
export function codexConversationOf(
  id: string,
  rows: readonly Line[],
  {
    folder,
    fresh,
    truncated,
  }: { folder: string; fresh: boolean; truncated: boolean },
): Conversation {
  const turns = buildCodexTurns(rows, folder);
  const working = fresh && codexWorking(rows as Line[]);
  const last = turns.at(-1);
  if (last?.role === "assistant") {
    last.open = working;
    if (working) last.endedAt = null;
  }
  const meta = record(
    rows.find((line) => line.type === "session_meta")?.payload,
  );
  let card: AgentCard | null = null;
  if (working)
    for (let at = rows.length - 1; at >= 0 && !card; at--)
      card = laneworkCard(rows[at] as Line);
  return {
    id,
    agent: "codex",
    cwd: str(meta.cwd),
    branch: str(record(meta.git).branch),
    turns,
    working,
    card,
    settings: null,
    truncated,
  };
}

/** Rollout paths already found, by id: the tree is only walked once each. */
const found = new Map<string, string>();

/**
 * The rollout of Codex conversation `id`, if it is `folder`'s own — its
 * `session_meta` names that folder and it is somebody's conversation, not a
 * thread Codex spawned for itself — else null.
 *
 * ⚠️ The id passed `isAgentSessionId`, and only files under Codex's own
 * `sessions` tree are ever opened.
 */
export async function codexRolloutPath(
  home: string,
  folder: string,
  id: string,
): Promise<string | null> {
  if (!isAgentSessionId(id)) return null;
  let file = found.get(id) ?? null;
  if (file && !(await stat(file).catch(() => null))?.isFile()) {
    found.delete(id);
    file = null;
  }
  if (!file) {
    const all = await codexRollouts(join(home, ".codex", "sessions"));
    file = all.find((path) => path.endsWith(`-${id}.jsonl`)) ?? null;
    if (!file) return null;
  }
  const head = lines(await readRange(file, 0, META_CHUNK).catch(() => ""), {
    head: true,
  });
  const meta = record(
    head.find((line) => line.type === "session_meta")?.payload,
  );
  if (meta.id !== id || meta.cwd !== folder) return null;
  if (codexRole(meta).kind !== "conversation") return null;
  found.set(id, file);
  return file;
}

/**
 * Codex conversation `id` of `folder`, read for the chat. Past
 * `CONVERSATION_READ_MAX` only the end is read, and `truncated` says so —
 * its `session_meta` read from the head on its own.
 */
export async function readCodexConversation(
  home: string,
  folder: string,
  id: string,
  max = CONVERSATION_READ_MAX,
): Promise<Conversation> {
  const file = await codexRolloutPath(home, folder, id);
  const info = file ? await stat(file).catch(() => null) : null;
  if (!file || !info?.isFile())
    throw new Error("That conversation has no transcript.");
  const fresh = Date.now() - info.mtimeMs <= STALE_MS;
  const truncated = info.size > max;
  const start = truncated ? info.size - max : 0;
  let rows = lines(await readRange(file, start, info.size - start), {
    head: !truncated,
  });
  if (truncated) {
    const head = lines(await readRange(file, 0, META_CHUNK), { head: true });
    const meta = head.find((line) => line.type === "session_meta");
    if (meta) rows = [meta, ...rows];
  }
  return codexConversationOf(id, rows, { folder, fresh, truncated });
}
