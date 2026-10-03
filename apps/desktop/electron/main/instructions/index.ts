// What a project's agents are told, for the Instructions screen (FE-37).
//
// ⚠️ Read-only. The renderer names a project by slug and a file by an id
// from main's own last listing of it; the paths stay here, so no renderer can
// point a read at a file of its choosing. There is no channel that writes.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import {
  type EffectiveInstructions,
  type InstructionAgent,
  type InstructionContent,
  type InstructionList,
  instructionChannels,
  isInstructionAgent,
  isInstructionId,
} from "../../../shared/instructions";
import { broadcast, handle } from "../ipc";
import { terminalFolder } from "../workspaces";
import {
  effectiveInstructions,
  type InstructionRoots,
  type InstructionTree,
  listInstructions,
  managedClaudeMd,
  readInstruction,
  watchInstructions,
} from "./read";

/** The home `~/` means — under the test's fake home in a dev build. */
function home(): string {
  return (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir();
}

/** Where each CLI keeps its own files, as each reads its environment. */
function rootsFor(folder: string): InstructionRoots {
  const at = home();
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR;
  return {
    folder,
    home: at,
    claudeHome: claudeConfig || join(at, ".claude"),
    codexHome: process.env.CODEX_HOME || join(at, ".codex"),
    claudeJson: claudeConfig
      ? join(claudeConfig, ".claude.json")
      : join(at, ".claude.json"),
    managed: managedClaudeMd(),
  };
}

/**
 * The last listing of each project, which every read is checked against, and
 * one watch on the folders it found (FE-37/D7). Capped like Memory's.
 */
const listed = new Map<
  string,
  {
    roots: InstructionRoots;
    tree: InstructionTree | null;
    dirs: string;
    stop: () => void;
  }
>();
const WATCH_LIMIT = 4;

function forget(workspace: string): void {
  listed.get(workspace)?.stop();
  listed.delete(workspace);
}

function remember(
  workspace: string,
  roots: InstructionRoots,
  tree: InstructionTree,
) {
  const dirs = tree.dirs.join("\n");
  const current = listed.get(workspace);
  if (current?.dirs === dirs && current.roots.folder === roots.folder) {
    current.tree = tree;
    return;
  }
  forget(workspace);
  if (listed.size >= WATCH_LIMIT) {
    const [oldest] = listed.keys();
    if (oldest !== undefined) forget(oldest);
  }
  const entry = {
    roots,
    tree: tree as InstructionTree | null,
    dirs,
    stop: () => {},
  };
  entry.stop = watchInstructions(tree.dirs, () => {
    // Stale from now on: the next read lists again before it opens anything.
    entry.tree = null;
    broadcast(instructionChannels.changed, { workspace });
  });
  listed.set(workspace, entry);
}

const EMPTY: Omit<InstructionList, "claudeMode"> = {
  folder: null,
  files: {},
  claude: [],
  codex: [],
  nested: [],
  nestedTruncated: false,
};

async function list(workspace: string): Promise<InstructionList> {
  const folder = await terminalFolder(workspace);
  if (!folder) {
    forget(workspace);
    return { ...EMPTY, claudeMode: "claude-md-or-agents-md" };
  }
  const roots = rootsFor(folder);
  const tree = await listInstructions(roots);
  remember(workspace, roots, tree);
  return tree.list;
}

/** The listing a read is checked against: the last one, or a fresh one. */
async function current(
  workspace: string,
): Promise<{ roots: InstructionRoots; tree: InstructionTree }> {
  const folder = await terminalFolder(workspace);
  if (!folder) throw new Error("This project has no folder on this machine.");
  const known = listed.get(workspace);
  if (known?.tree && known.roots.folder === folder)
    return { roots: known.roots, tree: known.tree };
  const roots = rootsFor(folder);
  const tree = await listInstructions(roots);
  remember(workspace, roots, tree);
  return { roots, tree };
}

async function read(
  workspace: string,
  id: string,
): Promise<InstructionContent> {
  const { roots, tree } = await current(workspace);
  return readInstruction(tree, roots, id);
}

async function effective(
  workspace: string,
  agent: InstructionAgent,
): Promise<EffectiveInstructions> {
  const { tree } = await current(workspace);
  return effectiveInstructions(tree, agent);
}

async function reveal(workspace: string, id: string): Promise<void> {
  const { tree } = await current(workspace);
  const path = tree.paths.get(id);
  const info = path ? await stat(path).catch(() => null) : null;
  if (!path || !info?.isFile())
    throw new Error("That file is not on this machine any more.");
  // Selects the file in Finder; nothing is opened or written (FE-37/D8).
  shell.showItemInFolder(path);
}

function workspaceArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required");
  return value;
}

function idArg(value: unknown): string {
  if (!isInstructionId(value)) throw new Error("That is not a file id.");
  return value;
}

export function registerInstructions(devUrl?: string): void {
  handle(instructionChannels.list, devUrl, (args) => {
    if (args.length !== 1) throw new Error("list takes one project");
    return list(workspaceArg(args[0]));
  });
  handle(instructionChannels.read, devUrl, (args) => {
    if (args.length !== 2) throw new Error("read takes a project and a file");
    return read(workspaceArg(args[0]), idArg(args[1]));
  });
  handle(instructionChannels.effective, devUrl, (args) => {
    if (args.length !== 2 || !isInstructionAgent(args[1]))
      throw new Error("effective takes a project and an agent");
    return effective(workspaceArg(args[0]), args[1]);
  });
  handle(instructionChannels.reveal, devUrl, (args) => {
    if (args.length !== 2) throw new Error("reveal takes a project and a file");
    return reveal(workspaceArg(args[0]), idArg(args[1]));
  });
}
