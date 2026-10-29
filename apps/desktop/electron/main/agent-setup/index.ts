// A project's agent setup, for Settings → Projects.
//
// NOTE: Read-only, but for the trust answer (FE-101). The renderer names a
// project by slug, and a skill or
// command by the id `read` handed out with it. The folder is resolved here,
// from the folder links this process wrote down, and the file from a fresh
// read of that folder's setup. So no renderer can point a read, or Finder, at
// a file of its choosing. There is no channel that writes a project's files.
//
// Two writes: the `lanework` MCP entry in the agents' user config
// (`mcp-entry.ts`), and only that entry (FE-52/D8); and each CLI's trust
// record for the project's own folder, on the user's confirmed click
// (FE-101).
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { app, shell } from "electron";
import {
  type AgentSetup,
  agentSetupChannels,
  isSetupId,
  type ProjectTrust,
  type SetupAgent,
  type SetupFile,
  type SetupScope,
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
import { readClaudeTrust, setClaudeTrust } from "../conversation/claude-trust";
import { readCodexTrust, setCodexTrust } from "../conversation/codex-trust";
import { sharedEngines } from "../conversation/engine";
import { projectRoot } from "../instructions/read";
import { handle } from "../ipc";
import { agentHomeDir } from "../test-seams";
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
 * Where Claude and Codex keep their config.
 *
 * `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` as they read them, else the home
 * folder: the test's fake one in a dev build.
 */
function where() {
  return agentHome(agentHomeDir());
}

async function read(slug: string): Promise<AgentSetup> {
  const folder = await terminalFolder(slug);
  return (await readAgentSetup(folder, where())).setup;
}

const GLOBAL_SCOPES = new Set<SetupScope>(["user", "plugin", "system"]);

/**
 * Read what every project gets (Settings › MCP).
 *
 * The user's own config, the plugins installed for the user, and Codex's
 * system skills: no folder's.
 *
 * NOTE: It reads against a folder that is not there. `readAgentSetup` reads
 * the user's files whatever the folder, and finds nothing of a project's in
 * one that does not exist. The scope filter is still what makes it global:
 * it drops anything keyed to that path (a `local` entry, a project plugin).
 *
 * @throws When the made-up folder happens to exist.
 */
async function readGlobal(): Promise<AgentSetup> {
  const nowhere = join(
    app.getPath("temp"),
    `lanework-no-project-${randomUUID()}`,
  );
  const there = await stat(nowhere).then(
    () => true,
    () => false,
  );
  if (there) throw new Error("Could not read your agent setup. Try again.");
  const { setup } = await readAgentSetup(nowhere, where());
  const global = <T extends { scope: SetupScope }>(items: T[]) =>
    items.filter((item) => GLOBAL_SCOPES.has(item.scope));
  return {
    ...setup,
    folder: null,
    mcp: global(setup.mcp),
    skills: global(setup.skills),
    commands: global(setup.commands),
    hooks: global(setup.hooks),
    permissions: global(setup.permissions),
    plugins: global(setup.plugins),
  };
}

/**
 * The skill or command `id` names, as this folder's setup reads now.
 *
 * @throws When the project has no folder here, or the file is gone.
 */
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

/** `path` with the home folder shortened to `~`. */
function shortened(path: string): string {
  const { home } = where();
  return path === home || path.startsWith(home + sep)
    ? `~${path.slice(home.length)}`
    : path;
}

/** The project's folder, as given and as its real path. */
async function trustFolders(slug: string) {
  const folder = await terminalFolder(slug);
  if (!folder) return null;
  const real = await realpath(folder).catch(() => resolve(folder));
  return { folder, real };
}

const NO_TRUST = { trusted: false, own: null, from: null };

/** Whether each CLI trusts the project's folder now, read fresh (FE-101). */
async function trust(slug: string): Promise<ProjectTrust> {
  const at = await trustFolders(slug);
  if (!at) return { folder: null, claude: NO_TRUST, codex: NO_TRUST };
  const home = where();
  const claude = await readClaudeTrust(at.folder, home.claudeJson);
  const codex = await readCodexTrust(
    [at.folder, at.real],
    await projectRoot(at.folder),
    join(home.codexDir, "config.toml"),
  );
  return {
    folder: shortened(at.folder),
    claude: {
      trusted: claude.own === true || claude.from !== null,
      own: claude.own,
      from: claude.from ? shortened(claude.from) : null,
    },
    codex: {
      trusted: codex.trusted,
      own: codex.own === null ? null : codex.own === "trusted",
      from: codex.from ? shortened(codex.from) : null,
    },
  };
}

/**
 * Write the user's trust answer for one CLI, then bring the project's open
 * chats onto it (FE-101).
 */
async function setTrust(
  slug: string,
  agent: SetupAgent,
  on: boolean,
): Promise<ProjectTrust> {
  const at = await trustFolders(slug);
  if (!at) throw new Error("This project has no folder on this machine.");
  const home = where();
  if (agent === "claude") await setClaudeTrust(at.folder, on, home.claudeJson);
  else
    await setCodexTrust(
      [at.folder, at.real],
      on,
      join(home.codexDir, "config.toml"),
    );
  await sharedEngines()?.retrust(slug, at.folder, agent);
  return trust(slug);
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

/** The `lanework` MCP entry, against what the session wants (FE-52/D8). */
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
    return loginLaneworkMcp(args[0], (url) => {
      void shell.openExternal(url).catch(() => {});
    });
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
  handle(agentSetupChannels.readGlobal, devUrl, (args) => {
    if (args.length) throw new Error("readGlobal takes no arguments");
    return readGlobal();
  });
  handle(agentSetupChannels.open, devUrl, (args) => {
    if (args.length !== 2) throw new Error("open takes a project and an id");
    return open(slugArg(args[0]), idArg(args[1]));
  });
  handle(agentSetupChannels.reveal, devUrl, (args) => {
    if (args.length !== 2) throw new Error("reveal takes a project and an id");
    return reveal(slugArg(args[0]), idArg(args[1]));
  });
  handle(agentSetupChannels.trust, devUrl, (args) => {
    if (args.length !== 1) throw new Error("trust takes one project");
    return trust(slugArg(args[0]));
  });
  handle(agentSetupChannels.setTrust, devUrl, (args) => {
    if (
      args.length !== 3 ||
      (args[1] !== "claude" && args[1] !== "codex") ||
      typeof args[2] !== "boolean"
    )
      throw new Error(
        'setTrust takes a project, "claude" or "codex", and true or false',
      );
    return setTrust(slugArg(args[0]), args[1], args[2]);
  });
}
