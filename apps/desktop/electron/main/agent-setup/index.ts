// A project's agent setup, for Settings → Projects (FE-40).
//
// ⚠️ Read-only. The renderer names a project by slug and a skill or command
// by the id `read` handed out with it; the folder is resolved here, from the
// folder links this process wrote down, and the file from a fresh read of
// that folder's setup — so no renderer can point a read, or Finder, at a
// file of its choosing. There is no channel that writes a project's files.
//
// FE-52/D8 adds the one write: the `lanework` MCP entry in the agents' USER
// config (`mcp-entry.ts`), and only that entry.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { app, shell } from "electron";
import {
  type AgentSetup,
  agentSetupChannels,
  isSetupId,
  type SetupFile,
} from "../../../shared/agent-setup";
import {
  type LaneworkMcpAgent,
  type LaneworkMcpStatus,
  laneworkMcpChannels,
} from "../../../shared/auth";
import { agentHome } from "../agent-home";
import { currentSession } from "../auth";
import { readLocalMode } from "../auth/local-mode";
import { readRecord } from "../auth/store";
import { handle } from "../ipc";
import { terminalFolder } from "../workspaces";
import { laneworkMcpAuth, loginLaneworkMcp } from "./mcp-auth";
import {
  installLaneworkMcp,
  laneworkMcpStatus,
  modeFor,
  removeLaneworkMcp,
  setMcpHome,
  syncLaneworkMcp,
} from "./mcp-entry";
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

/** FE-52/D8: the `lanework` MCP entry, against what the session wants. */
async function mcpStatus(): Promise<LaneworkMcpStatus> {
  const session = await currentSession();
  return laneworkMcpStatus(modeFor(session.principal.kind));
}

async function mcpInstall(agent: LaneworkMcpAgent): Promise<LaneworkMcpStatus> {
  const session = await currentSession();
  const mode = modeFor(session.principal.kind);
  if (!mode)
    throw new Error(
      "Sign in, or continue without an account, before adding the Lanework MCP server.",
    );
  await installLaneworkMcp(agent, mode);
  return laneworkMcpStatus(mode);
}

async function mcpRemove(agent: LaneworkMcpAgent): Promise<LaneworkMcpStatus> {
  await removeLaneworkMcp(agent);
  return mcpStatus();
}

const isMcpAgent = (value: unknown): value is LaneworkMcpAgent =>
  value === "claude-code" || value === "codex";

export function registerAgentSetup(devUrl?: string): void {
  setMcpHome(where);
  handle(laneworkMcpChannels.status, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return mcpStatus();
  });
  handle(laneworkMcpChannels.install, devUrl, (args) => {
    if (args.length !== 1 || !isMcpAgent(args[0]))
      throw new Error('install takes "claude-code" or "codex"');
    return mcpInstall(args[0]);
  });
  handle(laneworkMcpChannels.remove, devUrl, (args) => {
    if (args.length !== 1 || !isMcpAgent(args[0]))
      throw new Error('remove takes "claude-code" or "codex"');
    return mcpRemove(args[0]);
  });
  handle(laneworkMcpChannels.auth, devUrl, (args) => {
    if (args.length !== 1 || !isMcpAgent(args[0]))
      throw new Error('auth takes "claude-code" or "codex"');
    return laneworkMcpAuth(args[0]);
  });
  handle(laneworkMcpChannels.login, devUrl, (args) => {
    if (args.length !== 1 || !isMcpAgent(args[0]))
      throw new Error('login takes "claude-code" or "codex"');
    return loginLaneworkMcp(args[0]);
  });
  // On every launch: entries that are ours follow the mode, and a stdio one
  // gets this build's shim. Read from disk rather than `currentSession()`,
  // which would probe the control plane before any window asked it to.
  void (async () => {
    const record = await readRecord();
    const kind = record ? "machine" : (await readLocalMode()) ? "local" : null;
    if (kind) await syncLaneworkMcp(kind);
  })().catch((error: unknown) =>
    console.warn("could not bring the Lanework MCP entry up to date", error),
  );
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
