// What a project's agents are told, for the Instructions screen.
//
// NOTE: Read-only. The renderer names a project by slug and a file by an id
// from main's own last listing. The paths stay here, so no renderer can point
// a read at a file of its choosing. No channel writes.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { shell } from "electron";
import {
  type EffectiveInstructions,
  type InstructionAgent,
  type InstructionContent,
  type InstructionList,
  instructionChannels,
  isInstructionAgent,
  isInstructionId,
} from "../../../shared/instructions";
import { opencodeConfigDir } from "../agent-setup/opencode";
import { broadcast, handle } from "../ipc";
import { terminalFolder } from "../projects";
import { agentHomeDir } from "../test-seams";
import {
  effectiveInstructions,
  type InstructionRoots,
  type InstructionTree,
  listInstructions,
  managedClaudeMd,
  readInstruction,
  watchInstructions,
} from "./read";

/** The home `~/` means: the test's fake home in a dev build, else the real. */
function home(): string {
  return agentHomeDir();
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
    opencodeConfig: opencodeConfigDir(at),
    claudeJson: claudeConfig
      ? join(claudeConfig, ".claude.json")
      : join(at, ".claude.json"),
    managed: managedClaudeMd(),
  };
}

/**
 * The last listing of each project, which every read is checked against.
 *
 * Each has one watch on the folders it found (FE-37/D7). Capped at
 * `WATCH_LIMIT` projects, like Memory's.
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

function forget(project: string): void {
  listed.get(project)?.stop();
  listed.delete(project);
}

function remember(
  project: string,
  roots: InstructionRoots,
  tree: InstructionTree,
) {
  const dirs = tree.dirs.join("\n");
  const current = listed.get(project);
  if (current?.dirs === dirs && current.roots.folder === roots.folder) {
    current.tree = tree;
    return;
  }
  forget(project);
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
    broadcast(instructionChannels.changed, { project });
  });
  listed.set(project, entry);
}

const EMPTY: Omit<InstructionList, "claudeMode"> = {
  folder: null,
  files: {},
  claude: [],
  codex: [],
  opencode: [],
  nested: [],
  nestedTruncated: false,
};

async function list(project: string): Promise<InstructionList> {
  const folder = await terminalFolder(project);
  if (!folder) {
    forget(project);
    return { ...EMPTY, claudeMode: "claude-md-or-agents-md" };
  }
  const roots = rootsFor(folder);
  const tree = await listInstructions(roots);
  remember(project, roots, tree);
  return tree.list;
}

/**
 * The listing a read is checked against: the last one, or a fresh one.
 *
 * @throws When the project has no folder on this machine.
 */
async function current(
  project: string,
): Promise<{ roots: InstructionRoots; tree: InstructionTree }> {
  const folder = await terminalFolder(project);
  if (!folder) throw new Error("This project has no folder on this machine.");
  const known = listed.get(project);
  if (known?.tree && known.roots.folder === folder)
    return { roots: known.roots, tree: known.tree };
  const roots = rootsFor(folder);
  const tree = await listInstructions(roots);
  remember(project, roots, tree);
  return { roots, tree };
}

async function read(project: string, id: string): Promise<InstructionContent> {
  const { roots, tree } = await current(project);
  return readInstruction(tree, roots, id);
}

async function effective(
  project: string,
  agent: InstructionAgent,
): Promise<EffectiveInstructions> {
  const { tree } = await current(project);
  return effectiveInstructions(tree, agent);
}

async function reveal(project: string, id: string): Promise<void> {
  const { tree } = await current(project);
  const path = tree.paths.get(id);
  const info = path ? await stat(path).catch(() => null) : null;
  if (!path || !info?.isFile())
    throw new Error("That file is not on this machine any more.");
  // Selects the file in Finder. Nothing is opened or written (FE-37/D8).
  shell.showItemInFolder(path);
}

function projectArg(value: unknown): string {
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
    return list(projectArg(args[0]));
  });
  handle(instructionChannels.read, devUrl, (args) => {
    if (args.length !== 2) throw new Error("read takes a project and a file");
    return read(projectArg(args[0]), idArg(args[1]));
  });
  handle(instructionChannels.effective, devUrl, (args) => {
    if (args.length !== 2 || !isInstructionAgent(args[1]))
      throw new Error("effective takes a project and an agent");
    return effective(projectArg(args[0]), args[1]);
  });
  handle(instructionChannels.reveal, devUrl, (args) => {
    if (args.length !== 2) throw new Error("reveal takes a project and a file");
    return reveal(projectArg(args[0]), idArg(args[1]));
  });
}
