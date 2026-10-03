// A project's agent setup, for Settings → Projects (FE-40).
//
// ⚠️ Read-only. The renderer names a project by slug and a skill or command
// by the id `read` handed out with it; the folder is resolved here, from the
// folder links this process wrote down, and the file from a fresh read of
// that folder's setup — so no renderer can point a read, or Finder, at a
// file of its choosing. There is no channel that writes.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { app, shell } from "electron";
import {
  type AgentSetup,
  agentSetupChannels,
  isSetupId,
  type SetupFile,
} from "../../../shared/agent-setup";
import { agentHome } from "../agent-home";
import { handle } from "../ipc";
import { terminalFolder } from "../workspaces";
import { readAgentSetup, readSetupFile } from "./read";

/**
 * Where Claude and Codex keep their config: `$CLAUDE_CONFIG_DIR` and
 * `$CODEX_HOME` as they read them, else the home folder — the test's fake
 * one in a dev build.
 */
function where() {
  return agentHome(
    (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir(),
  );
}

async function read(slug: string): Promise<AgentSetup> {
  const folder = await terminalFolder(slug);
  return (await readAgentSetup(folder, where())).setup;
}

/** The skill or command `id` names, as this folder's setup reads NOW. */
async function fileOf(slug: string, id: string) {
  const folder = await terminalFolder(slug);
  if (!folder) throw new Error("This project has no folder on this machine.");
  const { setup, files } = await readAgentSetup(folder, where());
  const path = files.get(id);
  const entry = [...setup.skills, ...setup.commands].find(
    (doc) => doc.id === id,
  );
  if (!path || !entry)
    throw new Error("That file is no longer there. Look at the setup again.");
  return { path, entry };
}

async function open(slug: string, id: string): Promise<SetupFile> {
  const { path, entry } = await fileOf(slug, id);
  return {
    id,
    name: entry.name,
    source: entry.source,
    ...(await readSetupFile(path)),
  };
}

async function reveal(slug: string, id: string): Promise<void> {
  const { path } = await fileOf(slug, id);
  const there = await stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!there) throw new Error("That file is no longer on this machine.");
  shell.showItemInFolder(path);
}

function slugArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("A project is required");
  return value;
}

function idArg(value: unknown): string {
  if (!isSetupId(value)) throw new Error("That is not a skill or command.");
  return value;
}

export function registerAgentSetup(devUrl?: string): void {
  handle(agentSetupChannels.read, devUrl, (args) => {
    if (args.length !== 1) throw new Error("read takes one project");
    return read(slugArg(args[0]));
  });
  handle(agentSetupChannels.open, devUrl, (args) => {
    if (args.length !== 2) throw new Error("open takes a project and an id");
    return open(slugArg(args[0]), idArg(args[1]));
  });
  handle(agentSetupChannels.reveal, devUrl, (args) => {
    if (args.length !== 2) throw new Error("reveal takes a project and an id");
    return reveal(slugArg(args[0]), idArg(args[1]));
  });
}
