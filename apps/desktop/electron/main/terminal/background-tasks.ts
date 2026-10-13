// The tasks a Claude conversation started in the background (FE-42): a shell
// `Bash` left running, an async agent, a `Monitor` — read from the
// conversation's own transcript, and a shell's output read from the file the
// CLI said it writes to.
//
// FE-43 also stops a shell's process group. Nothing here imports Electron:
// main calls it, and specs drive it under Node with isolated task fixtures.
import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  BACKGROUND_COMMAND_MAX,
  BACKGROUND_OUTPUT_MAX,
  type BackgroundCount,
  type BackgroundTask,
  type BackgroundTaskKind,
  type BackgroundTaskOutput,
  type BackgroundTaskStatus,
  isAgentSessionId,
  isBackgroundTaskId,
} from "../../../shared/terminal";
import { claudeProjectDir, type Line, STALE_MS, tidy } from "./agent-sessions";

/** How much of a transcript one read step takes. */
const STEP = 1024 * 1024;
/** Transcripts whose parse is kept between listings: more than a listing reads (40). */
const CACHE_MAX = 128;
/**
 * The only lines that can start, name or end a background task: a line
 * holding none of these is never parsed — a transcript runs to tens of MB.
 */
const MARKERS = [
  "backgroundTaskId",
  "async_launched",
  '"taskId"',
  "task-notification",
  "run_in_background",
  '"name":"Agent"',
  '"name":"Task"',
  '"name":"Monitor"',
  "Successfully stopped task",
  "Successfully killed shell",
];
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const OUTPUT_PATH = /Output is being written to: (\S+\.output)/;
const EXIT_CODE = /exit code (-?\d+)/i;
/** A terminal escape: an OSC title or link, a CSI colour or move, or a lone one. */
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escapes are what it removes.
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/** A task as the transcript built it, with where its output goes. */
interface Started {
  task: Omit<
    BackgroundTask,
    "status" | "exitCode" | "summary" | "endedAt" | "pid"
  >;
  /** The output file the CLI named in its answer; a shell's only. */
  output: string | null;
  /** A shell's or monitor's whole command, uncut: what its process runs. */
  script: string | null;
}

interface Notice {
  status: BackgroundTaskStatus | null;
  exitCode: number | null;
  summary: string | null;
  at: string | null;
}

/** What one transcript says so far, and how far it was read. */
interface Parsed {
  size: number;
  mtimeMs: number;
  /** Bytes read up to the end of the last whole line. */
  offset: number;
  calls: Map<
    string,
    { name: string; input: Record<string, unknown>; at: string | null }
  >;
  started: Map<string, Started>;
  notices: Map<string, Notice>;
}

const runFile = promisify(execFile);
const stoppedTasks = new Set<string>();

const cache = new Map<string, Parsed>();
/** One read of a file at a time: a second waits and takes the cache. */
const reading = new Map<string, Promise<Parsed>>();

/** Where conversation `conversation` of `folder` is kept, built here, never sent. */
export function claudeTranscriptPath(
  home: string,
  folder: string,
  conversation: string,
): string {
  if (!isAgentSessionId(conversation))
    throw new Error("A valid conversation is required");
  return join(
    home,
    ".claude",
    "projects",
    claudeProjectDir(folder),
    `${conversation}.jsonl`,
  );
}

function workspaceArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A valid workspace is required");
  return value;
}

/** `agentBackgroundTasks`' request off the wire: ids, never a path. */
export function backgroundRequest(args: unknown[]): {
  workspace: string;
  conversation: string;
} {
  if (args.length !== 2)
    throw new Error("A workspace and a conversation are required");
  const workspace = workspaceArg(args[0]);
  if (!isAgentSessionId(args[1]))
    throw new Error("A valid conversation is required");
  return { workspace, conversation: args[1] };
}

/** `agentTaskOutput`'s request off the wire: ids, never a path. */
export function taskOutputRequest(args: unknown[]): {
  workspace: string;
  conversation: string;
  task: string;
} {
  if (args.length !== 3)
    throw new Error("A workspace, a conversation and a task are required");
  const workspace = workspaceArg(args[0]);
  if (!isAgentSessionId(args[1]))
    throw new Error("A valid conversation is required");
  if (!isBackgroundTaskId(args[2])) throw new Error("A valid task is required");
  return { workspace, conversation: args[1], task: args[2] };
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The text of a message's content: a string, or its text parts joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      if (typeof item.text === "string") return item.text;
      return contentText(item.content);
    })
    .join("\n");
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return match ? decode(match[1].trim()) : null;
}

/** Claude's status words, as a task's (`stopped`: its session ended first). */
function statusOf(word: string | null): BackgroundTaskStatus | null {
  switch (word) {
    case "completed":
    case "failed":
    case "killed":
      return word;
    case "stopped":
      return "lost";
    default:
      return null;
  }
}

function notify(parsed: Parsed, text: string, at: string | null) {
  for (const match of text.matchAll(NOTIFICATION)) {
    const body = match[1];
    const id = tag(body, "task-id");
    if (!id || !isBackgroundTaskId(id)) continue;
    const summary = tag(body, "summary");
    const status = statusOf(tag(body, "status"));
    const prior = parsed.notices.get(id);
    // A Monitor's event has no status: news, never an end.
    if (!status) {
      parsed.notices.set(id, {
        status: prior?.status ?? null,
        exitCode: prior?.exitCode ?? null,
        summary: summary ?? prior?.summary ?? null,
        at: prior?.at ?? null,
      });
      continue;
    }
    const code = summary ? EXIT_CODE.exec(summary) : null;
    parsed.notices.set(id, {
      status,
      exitCode: code ? Number(code[1]) : null,
      summary,
      at,
    });
  }
}

/**
 * The task a `TaskStop` (or the older `KillShell`) answer says it stopped. The
 * CLI sends no notification for a task stopped this way: this answer is the
 * only word of its end.
 */
function stoppedBy(result: Record<string, unknown>): string | null {
  const message = str(result.message);
  if (!message || !/^Successfully (stopped task|killed shell)/.test(message))
    return null;
  const id = result.task_id ?? result.shell_id;
  return typeof id === "string" && isBackgroundTaskId(id) ? id : null;
}

function kindOf(
  name: string | undefined,
  result: Record<string, unknown>,
): { kind: BackgroundTaskKind; id: string } | null {
  if (
    typeof result.backgroundTaskId === "string" &&
    isBackgroundTaskId(result.backgroundTaskId)
  )
    return { kind: "shell", id: result.backgroundTaskId };
  if (
    result.isAsync === true &&
    typeof result.agentId === "string" &&
    isBackgroundTaskId(result.agentId)
  )
    return { kind: "agent", id: result.agentId };
  if (
    typeof result.taskId === "string" &&
    isBackgroundTaskId(result.taskId) &&
    (name === "Monitor" || "timeoutMs" in result)
  )
    return { kind: "monitor", id: result.taskId };
  return null;
}

function cut(text: string): string {
  return text.length > BACKGROUND_COMMAND_MAX
    ? `${text.slice(0, BACKGROUND_COMMAND_MAX - 1)}…`
    : text;
}

/** One transcript line, folded into what is known so far. */
function visit(parsed: Parsed, line: Line) {
  if (line.isSidechain === true) return;
  const at = str(line.timestamp);
  if (line.type === "assistant") {
    const content = (record(line.message)?.content ?? []) as unknown;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const item = record(part);
      if (item?.type !== "tool_use" || typeof item.id !== "string") continue;
      const name = String(item.name ?? "");
      const input = record(item.input) ?? {};
      if (
        name === "Agent" ||
        name === "Task" ||
        name === "Monitor" ||
        input.run_in_background === true
      )
        parsed.calls.set(item.id, {
          name,
          // Only what a task shows: a prompt can be long.
          input: { description: input.description, command: input.command },
          at,
        });
    }
    return;
  }
  if (line.type === "attachment") {
    const prompt = record(line.attachment)?.prompt;
    if (typeof prompt === "string") notify(parsed, prompt, at);
    return;
  }
  if (line.type !== "user") return;
  const message = record(line.message);
  const result = record(line.toolUseResult);
  const content = message?.content;
  if (result && Array.isArray(content)) {
    const answer = content
      .map(record)
      .find((item) => item?.type === "tool_result");
    const toolUseId = str(answer?.tool_use_id);
    if (answer && toolUseId) {
      const call = parsed.calls.get(toolUseId);
      // Answered: started in the background or not, the call is done with.
      parsed.calls.delete(toolUseId);
      const stopped = stoppedBy(result);
      if (stopped) {
        // A task that already reported keeps how it ended.
        if (!parsed.notices.get(stopped)?.status)
          parsed.notices.set(stopped, {
            status: "killed",
            exitCode: null,
            summary: parsed.notices.get(stopped)?.summary ?? null,
            at,
          });
        return;
      }
      const which = kindOf(call?.name, result);
      if (which) {
        // A `ws` monitor has no command, and so no process (FE-56).
        const command =
          which.kind === "agent" ? null : str(call?.input.command);
        const description =
          str(call?.input.description) ??
          str(result.description) ??
          (command ? command.split("\n")[0] : null) ??
          which.kind;
        const output =
          which.kind === "shell"
            ? (OUTPUT_PATH.exec(contentText(answer.content))?.[1] ?? null)
            : null;
        parsed.started.set(which.id, {
          task: {
            id: which.id,
            toolUseId,
            kind: which.kind,
            description: tidy(description),
            command: command ? cut(command) : null,
            subagentId: which.kind === "agent" ? which.id : null,
            startedAt: call?.at ?? at ?? new Date(0).toISOString(),
          },
          output,
          script: command,
        });
      }
      return;
    }
  }
  const text = contentText(content);
  if (text.includes("<task-notification>")) notify(parsed, text, at);
}

function fresh(size: number, mtimeMs: number): Parsed {
  return {
    size,
    mtimeMs,
    offset: 0,
    calls: new Map(),
    started: new Map(),
    notices: new Map(),
  };
}

/**
 * `file` parsed up to its end. A transcript only grows, so a cached parse
 * reads on from where it stopped; one that shrank is read again.
 */
async function parse(file: string): Promise<Parsed> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("That conversation has no transcript.");
  const cached = cache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    cache.delete(file);
    cache.set(file, cached);
    return cached;
  }
  const parsed =
    cached && cached.offset <= info.size
      ? cached
      : fresh(info.size, info.mtimeMs);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(STEP);
    let carry = "";
    let position = parsed.offset;
    while (position < info.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(STEP, info.size - position),
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      // Cut on the last newline in bytes: a character is never split.
      const chunk = buffer.subarray(0, bytesRead);
      const last = chunk.lastIndexOf(0x0a);
      if (last < 0) {
        carry += chunk.toString("utf8");
        continue;
      }
      const text = carry + chunk.subarray(0, last).toString("utf8");
      carry = chunk.subarray(last + 1).toString("utf8");
      parsed.offset = position - (bytesRead - last - 1);
      for (const part of text.split("\n")) {
        if (!MARKERS.some((marker) => part.includes(marker))) continue;
        try {
          const value: unknown = JSON.parse(part);
          const line = record(value);
          if (line) visit(parsed, line);
        } catch {
          // Not ours, or cut.
        }
      }
    }
  } finally {
    await handle.close();
  }
  parsed.size = info.size;
  parsed.mtimeMs = info.mtimeMs;
  cache.delete(file);
  cache.set(file, parsed);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return parsed;
}

function parseOnce(file: string): Promise<Parsed> {
  const prior = reading.get(file) ?? Promise.resolve(null);
  const next = prior.catch(() => null).then(() => parse(file));
  reading.set(file, next);
  const done = () => {
    if (reading.get(file) === next) reading.delete(file);
  };
  next.then(done, done);
  return next;
}

function tasksOf(parsed: Parsed, transcript: string): BackgroundTask[] {
  // No word from a task whose conversation went quiet long ago: the CLI that
  // owned it is gone.
  const stale = Date.now() - parsed.mtimeMs > STALE_MS;
  const out: BackgroundTask[] = [];
  for (const { task } of parsed.started.values()) {
    const notice = parsed.notices.get(task.id);
    const status: BackgroundTaskStatus =
      notice?.status === "failed" &&
      stoppedTasks.has(`${transcript}:${task.id}`)
        ? "killed"
        : (notice?.status ?? (stale ? "lost" : "running"));
    out.push({
      ...task,
      status,
      exitCode: notice?.status ? notice.exitCode : null,
      summary: notice?.summary ? tidy(notice.summary) : null,
      endedAt:
        status === "running" || status === "lost" ? null : (notice?.at ?? null),
      pid: null,
    });
  }
  const running = (task: BackgroundTask) => (task.status === "running" ? 0 : 1);
  return out.sort(
    (a, b) => running(a) - running(b) || b.startedAt.localeCompare(a.startedAt),
  );
}

/** The background tasks in transcript `file`, running first, then newest. */
export async function readTranscriptTasks(
  file: string,
): Promise<BackgroundTask[]> {
  return tasksOf(await parseOnce(file), file);
}

/** Conversation `conversation`'s background tasks (FE-42). */
export async function readBackgroundTasks(
  home: string,
  folder: string,
  conversation: string,
): Promise<BackgroundTask[]> {
  return readTranscriptTasks(claudeTranscriptPath(home, folder, conversation));
}

/** For the rail: how many are running, of how many. */
export function backgroundCount(tasks: BackgroundTask[]): BackgroundCount {
  return {
    running: tasks.filter((task) => task.status === "running").length,
    total: tasks.length,
  };
}

/**
 * Where Claude may keep task output: `/tmp` (where it really does on macOS),
 * the OS temp dir, and `$CLAUDE_CODE_TMPDIR` — each resolved, those that exist.
 */
export function tempRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of ["/tmp", tmpdir(), process.env.CLAUDE_CODE_TMPDIR]) {
    if (!dir) continue;
    try {
      roots.add(realpathSync(dir));
    } catch {
      // Not on this machine.
    }
  }
  return [...roots];
}

/**
 * Whether `resolved` is `<root>/claude-…/…/tasks/<task>.output` for one of
 * `roots` — symlinks already resolved, so none can point out of it.
 */
function insideTasks(resolved: string, task: string, roots: string[]): boolean {
  return roots.some((root) => {
    const inside = relative(root, resolved);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
    const parts = inside.split(sep);
    return (
      parts.length >= 3 &&
      parts[0].startsWith("claude-") &&
      parts[parts.length - 2] === "tasks" &&
      parts[parts.length - 1] === `${task}.output`
    );
  });
}

/** Terminal escapes out; of a line a progress bar redrew, its last state. */
export function plainOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const at = line.lastIndexOf("\r", line.length - 2);
      return (at >= 0 ? line.slice(at + 1) : line).replace(/\r$/, "");
    })
    .join("\n");
}

const MISSING: BackgroundTaskOutput = {
  text: "",
  size: 0,
  truncated: false,
  missing: true,
};

async function taskOutputPath(
  started: Started,
  task: string,
  roots: string[],
): Promise<string | null> {
  const recorded = started.output;
  if (
    !recorded ||
    !isAbsolute(recorded) ||
    basename(recorded) !== `${task}.output`
  )
    throw new Error("That task has no output to read.");
  let resolved: string;
  try {
    resolved = await realpath(recorded);
  } catch {
    // Gone, or never written: nothing to refuse.
    return null;
  }
  const allowed = await Promise.all(
    roots.map((root) => realpath(root).catch(() => null)),
  );
  if (
    !insideTasks(
      resolved,
      task,
      allowed.filter((root): root is string => root !== null),
    )
  )
    throw new Error("That task's output is outside the CLI's task folder.");
  return resolved;
}

/** One row of `ps`: enough to tell a task's process from any other. */
interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** `lstart` as `ps` writes it: with the pid, it tells a reused pid apart. */
  start: string;
  args: string;
}

const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/** Every process on this machine, in one `ps`. */
async function processTable(): Promise<Proc[]> {
  const { stdout } = await runFile(
    "ps",
    ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,args="],
    { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = PS_ROW.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            uid: Number(match[4]),
            start: match[5].replace(/\s+/g, " "),
            args: match[6],
          },
        ]
      : [];
  });
}

function ownUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Stopping tasks requires Unix process groups.");
  return uid;
}

/** The groups never signalled: the app's own, and every ancestor's. */
function guardedGroups(procs: Proc[]): Set<number> {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const own = byPid.get(process.pid)?.pgid;
  if (own === undefined || !Number.isInteger(own) || own <= 1)
    throw new Error("Cannot identify the app process group.");
  // A CLI or supervisor can also hold the file: never signal an ancestor.
  const groups = new Set([own]);
  const seen = new Set<number>();
  let at = byPid.get(process.pid);
  while (at && at.pid > 1 && !seen.has(at.pid)) {
    seen.add(at.pid);
    groups.add(at.pgid);
    at = byPid.get(at.ppid);
  }
  return groups;
}

/**
 * The same-user groups holding a shell's recorded output open, guarded ones
 * left out; null when the file is gone.
 */
async function shellGroups(
  started: Started,
  task: string,
  roots: string[],
  procs: Proc[],
  uid: number,
  guarded: Set<number>,
): Promise<Set<number> | null> {
  const resolved = await taskOutputPath(started, task, roots);
  if (!resolved) return null;
  let holders: string;
  try {
    holders = (await runFile("lsof", ["-t", "--", resolved])).stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return new Set();
    throw error;
  }
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const groups = new Set<number>();
  for (const pid of holders.trim().split(/\s+/)) {
    // A holder missing from the table exited between the two reads.
    const proc = /^\d+$/.test(pid) ? byPid.get(Number(pid)) : undefined;
    if (proc && proc.uid === uid && proc.pgid > 1 && !guarded.has(proc.pgid))
      groups.add(proc.pgid);
  }
  return groups;
}

/** Whether `args` launch Claude conversation `conversation`. */
function launches(args: string, conversation: string): boolean {
  const words = args.split(/\s+/);
  return words.some(
    (word, at) =>
      word === `--session-id=${conversation}` ||
      word === `--resume=${conversation}` ||
      ((word === "--session-id" || word === "--resume" || word === "-r") &&
        words[at + 1] === conversation),
  );
}

/** A command line as `ps` shows it: a control character, escaped or not, is `?`. */
function visible(text: string): string {
  return (
    text
      .replace(/\\[0-7]{3}/g, "?")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it hides.
      .replace(/[\u0000-\u001f]/g, "?")
  );
}

/** How the CLI hands a command to its shell: `eval '<command>'`. */
function evalOf(script: string): string {
  return visible(`eval '${script.replaceAll("'", `'"'"'`)}'`);
}

/**
 * Each running monitor's group leader (FE-56/D1): a group leader the
 * conversation's CLI started, running `eval '<its command>'`. Monitors with
 * the same command pair with such leaders by start order — only when there
 * are exactly as many; otherwise none of them gets one.
 */
function monitorLeaders(
  monitors: Started[],
  conversation: string,
  procs: Proc[],
  uid: number,
  taken: Set<number>,
): Map<string, number> {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const byScript = new Map<string, Started[]>();
  for (const monitor of monitors) {
    if (!monitor.script) continue;
    byScript.set(monitor.script, [
      ...(byScript.get(monitor.script) ?? []),
      monitor,
    ]);
  }
  const leaders = new Map<string, number>();
  for (const [script, group] of byScript) {
    const needle = evalOf(script);
    const found = procs
      .filter(
        (proc) =>
          proc.uid === uid &&
          proc.pid === proc.pgid &&
          proc.pgid > 1 &&
          !taken.has(proc.pgid) &&
          visible(proc.args).includes(needle) &&
          launches(byPid.get(proc.ppid)?.args ?? "", conversation),
      )
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    if (found.length !== group.length) continue;
    const order = [...group].sort((a, b) =>
      a.task.startedAt.localeCompare(b.task.startedAt),
    );
    for (const [at, monitor] of order.entries())
      leaders.set(monitor.task.id, found[at].pid);
  }
  return leaders;
}

/** The group leading each running shell and monitor, where exactly one does. */
async function taskLeaders(
  parsed: Parsed,
  transcript: string,
  conversation: string,
  roots: string[],
  procs: Proc[],
): Promise<Map<string, number>> {
  const uid = ownUid();
  const guarded = guardedGroups(procs);
  const running = tasksOf(parsed, transcript).filter(
    (task) => task.status === "running" && task.kind !== "agent",
  );
  const leaders = new Map<string, number>();
  const taken = new Set(guarded);
  for (const task of running.filter((entry) => entry.kind === "shell")) {
    const started = parsed.started.get(task.id);
    if (!started) continue;
    try {
      const groups = await shellGroups(
        started,
        task.id,
        roots,
        procs,
        uid,
        guarded,
      );
      for (const group of groups ?? []) taken.add(group);
      if (groups?.size === 1) leaders.set(task.id, [...groups][0]);
    } catch {
      // No output to look at: no pid, never a guess.
    }
  }
  const monitors = running.flatMap((task) => {
    const started =
      task.kind === "monitor" ? parsed.started.get(task.id) : undefined;
    return started ? [started] : [];
  });
  for (const [id, pid] of monitorLeaders(
    monitors,
    conversation,
    procs,
    uid,
    taken,
  ))
    leaders.set(id, pid);
  return leaders;
}

/**
 * Conversation `conversation`'s background tasks with the pid of each running
 * shell and monitor (FE-56). `ps` runs only while one is running (D5); a
 * failed read leaves every pid null.
 */
export async function readBackgroundTasksWithPids(
  home: string,
  folder: string,
  conversation: string,
  roots: string[] = tempRoots(),
): Promise<BackgroundTask[]> {
  const transcript = claudeTranscriptPath(home, folder, conversation);
  const parsed = await parseOnce(transcript);
  const tasks = tasksOf(parsed, transcript);
  if (!tasks.some((task) => task.status === "running" && task.kind !== "agent"))
    return tasks;
  try {
    const leaders = await taskLeaders(
      parsed,
      transcript,
      conversation,
      roots,
      await processTable(),
    );
    return tasks.map((task) => ({
      ...task,
      pid: leaders.get(task.id) ?? null,
    }));
  } catch {
    return tasks;
  }
}

/**
 * Stop a running shell (FE-43) or monitor (FE-56): only same-user process
 * groups — a shell's are those holding its recorded output; a monitor's is
 * the one leader `taskLeaders` finds for it, or it refuses.
 */
export async function stopBackgroundTask(
  home: string,
  folder: string,
  conversation: string,
  task: string,
  roots: string[] = tempRoots(),
): Promise<{ stopped: number }> {
  if (!isBackgroundTaskId(task)) throw new Error("A valid task is required");
  const transcript = claudeTranscriptPath(home, folder, conversation);
  const parsed = await parseOnce(transcript);
  const started = parsed.started.get(task);
  if (!started) throw new Error("That conversation started no such task.");
  if (started.task.kind === "agent")
    throw new Error("Only a shell or a monitor can be stopped.");
  if (
    tasksOf(parsed, transcript).find((item) => item.id === task)?.status !==
    "running"
  )
    throw new Error("That task is not running.");
  if (started.task.kind === "shell") await taskOutputPath(started, task, roots);
  const uid = ownUid();
  const before = await processTable();
  const guarded = guardedGroups(before);
  let groups: Set<number>;
  if (started.task.kind === "shell") {
    const found = await shellGroups(started, task, roots, before, uid, guarded);
    if (!found) return { stopped: 0 };
    groups = found;
  } else {
    const leader = (
      await taskLeaders(parsed, transcript, conversation, roots, before)
    ).get(task);
    if (leader === undefined)
      throw new Error("Could not tell which process runs this monitor.");
    groups = new Set([leader]);
  }
  const signaled = new Set<number>();
  for (const pgid of groups) {
    if (
      guarded.has(pgid) ||
      !before.some((member) => member.pgid === pgid && member.uid === uid)
    )
      continue;
    try {
      process.kill(-pgid, "SIGTERM");
      signaled.add(pgid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  // Every group member counts, children that close stdout after TERM too.
  const stopped = before.filter(
    (member) => signaled.has(member.pgid) && member.uid === uid,
  ).length;
  if (stopped) {
    stoppedTasks.add(`${transcript}:${task}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const after = await processTable();
    for (const pgid of signaled) {
      // A surviving original pid + start time: never escalate into a reused group.
      const survives = after.some(
        (member) =>
          member.pgid === pgid &&
          member.uid === uid &&
          before.some(
            (original) =>
              original.pid === member.pid &&
              original.pgid === pgid &&
              original.uid === member.uid &&
              original.start === member.start,
          ),
      );
      if (!survives) continue;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  return { stopped };
}

/**
 * The end of background task `task`'s output (FE-42/D5): its last
 * `BACKGROUND_OUTPUT_MAX` bytes, escapes stripped. Read anew on each call —
 * the renderer polls it while the task runs.
 *
 * ⚠️ Only from the path the conversation's own transcript recorded for that
 * task, and only when it resolves inside a CLI task folder under one of
 * `roots`. Anything else throws: an unknown task, a path elsewhere, a symlink
 * out of the folder.
 */
export async function readTaskOutput(
  home: string,
  folder: string,
  conversation: string,
  task: string,
  roots: string[] = tempRoots(),
): Promise<BackgroundTaskOutput> {
  if (!isBackgroundTaskId(task)) throw new Error("A valid task is required");
  const parsed = await parseOnce(
    claudeTranscriptPath(home, folder, conversation),
  );
  const started = parsed.started.get(task);
  if (!started) throw new Error("That conversation started no such task.");
  const resolved = await taskOutputPath(started, task, roots);
  if (!resolved) return MISSING;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Resolved already: a symlink swapped in since is refused, not followed.
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return MISSING;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return MISSING;
    const length = Math.min(info.size, BACKGROUND_OUTPUT_MAX);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      info.size - length,
    );
    let bytes = buffer.subarray(0, bytesRead);
    const truncated = info.size > length;
    // Cut mid-character: start at the next whole one.
    if (truncated) {
      let skip = 0;
      while (skip < bytes.length && skip < 4 && (bytes[skip] & 0xc0) === 0x80)
        skip++;
      bytes = bytes.subarray(skip);
    }
    return {
      text: plainOutput(bytes.toString("utf8")),
      size: info.size,
      truncated,
      missing: false,
    };
  } finally {
    await handle.close();
  }
}
