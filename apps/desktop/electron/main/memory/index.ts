// A project's Claude memory, for the Memory screen (FE-36).
//
// ⚠️ Read-only. The renderer names a project by slug and a memory by file
// NAME; the folder is resolved here, from the folder links this process
// wrote down, so no renderer can point a read at a file of its choosing.
// There is no channel that writes.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import {
  isMemoryFile,
  type MemoryFile,
  type MemoryList,
  memoryChannels,
} from "../../../shared/memory";
import { broadcast, handle } from "../ipc";
import { terminalFolder } from "../workspaces";
import { revealFolder } from "../workspaces/folder-chooser";
import { listMemory, memoryDir, readMemory, watchMemory } from "./read";

/**
 * Claude Code's own home, where its `projects/` are: `$CLAUDE_CONFIG_DIR`,
 * as it reads it, or `~/.claude` — under the test's fake home in a dev build.
 */
function claudeHome(): string {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  const home =
    (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir();
  return join(home, ".claude");
}

/** The project's folder here and its memory folder, or nulls without one. */
async function resolveDir(
  workspace: string,
): Promise<{ folder: string | null; dir: string | null }> {
  const folder = await terminalFolder(workspace);
  return folder
    ? { folder, dir: await memoryDir(claudeHome(), folder) }
    : { folder: null, dir: null };
}

const exists = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/**
 * One watch per project that has been listed (FE-36/D11), restarted when its
 * folder changes or appears. Capped: the rail lists every project it shows.
 */
const watching = new Map<
  string,
  { dir: string; existed: boolean; stop: () => void }
>();
const WATCH_LIMIT = 4;

function unwatch(workspace: string): void {
  watching.get(workspace)?.stop();
  watching.delete(workspace);
}

function watchWorkspace(workspace: string, dir: string, existed: boolean) {
  const current = watching.get(workspace);
  if (current?.dir === dir && current.existed === existed) return;
  unwatch(workspace);
  if (watching.size >= WATCH_LIMIT) {
    const [oldest] = watching.keys();
    if (oldest !== undefined) unwatch(oldest);
  }
  const stop = watchMemory(dir, () =>
    broadcast(memoryChannels.changed, { workspace }),
  );
  watching.set(workspace, { dir, existed, stop });
}

async function list(workspace: string): Promise<MemoryList> {
  const { folder, dir } = await resolveDir(workspace);
  if (!folder || !dir) {
    unwatch(workspace);
    return { folder: null, dir: null, entries: [], truncated: false };
  }
  const listed = await listMemory(dir);
  watchWorkspace(workspace, dir, listed !== null);
  return {
    folder,
    dir,
    entries: listed?.entries ?? [],
    truncated: listed?.truncated ?? false,
  };
}

async function read(workspace: string, file: string): Promise<MemoryFile> {
  const { dir } = await resolveDir(workspace);
  if (!dir) throw new Error("This project has no folder on this machine.");
  return readMemory(dir, file);
}

async function reveal(workspace: string): Promise<void> {
  const { dir } = await resolveDir(workspace);
  if (!dir || !(await exists(dir)))
    throw new Error("Claude has not saved any memory for this project yet.");
  await revealFolder(dir);
}

function workspaceArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required");
  return value;
}

export function registerMemory(devUrl?: string): void {
  handle(memoryChannels.list, devUrl, (args) => {
    if (args.length !== 1) throw new Error("list takes one project");
    return list(workspaceArg(args[0]));
  });
  handle(memoryChannels.read, devUrl, (args) => {
    if (args.length !== 2) throw new Error("read takes a project and a file");
    if (!isMemoryFile(args[1])) throw new Error("That is not a memory file.");
    return read(workspaceArg(args[0]), args[1]);
  });
  handle(memoryChannels.reveal, devUrl, (args) => {
    if (args.length !== 1) throw new Error("reveal takes one project");
    return reveal(workspaceArg(args[0]));
  });
}
