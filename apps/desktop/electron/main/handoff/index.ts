// Settings → Agents: switch the checkpoint Stop hook on and off for Claude
// Code, Codex and OpenCode on this machine, with no terminal and no token to
// paste.
//
// - On: our entry goes into the CLI's own settings (`~/.claude/settings.json`,
//   `~/.codex/hooks.json`; user level, so every repo gets it), or for OpenCode
//   our plugin file into `~/.config/opencode/plugins/` (FE-104), and this
//   machine's credential goes into the Keychain item the hook reads.
// - Off: our entry is removed, and nothing else in the file is touched; our
//   OpenCode plugin file is deleted.
//
// NOTE: Every entry runs one script, `~/.lanew/hooks/lanework-checkpoint`
// (FE-29/D3), which names this app's binary and the bundled hook. Those paths
// move when the app is updated or moved, so the script is rewritten on every
// launch (`syncHandoff`). The commands in the CLIs' files never change, and
// that keeps Codex's one-time approval valid.
//
// NOTE: Only a stable install writes that script (INF-05, GAP-02): see
// `shimRefusal` in `agent-setup/mcp-entry.ts`. A copy run from a DMG, an App
// Translocation path, an AppImage mount or a dev checkout would point every
// agent session at a binary that is gone once it quits.
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import {
  type AgentHookStatus,
  type HandoffStatus,
  type HookAgent,
  handoffChannels,
} from "../../../shared/handoff";
import {
  currentShimRefusal,
  type InstallFacts,
  setInstallFacts,
  shimRefusalMessage,
} from "../agent-setup/mcp-entry";
import { opencodeConfigDir } from "../agent-setup/opencode";
import { resolveApi } from "../auth/client";
import { readLocalMode } from "../auth/local-mode";
import { type MachineRecord, readRecord } from "../auth/store";
import { updateConfigFile } from "../config-file";
import { handle } from "../ipc";
import { appHomeDir } from "../paths";
import { agentHomeDir } from "../test-seams";
import {
  buildHookCommand,
  buildShim,
  claudeSettingsPath,
  findHook,
  findHookPosition,
  readSettings,
  updateSettings,
  withHook,
  withoutHook,
} from "./claude-settings";
import {
  codexConfigPath,
  codexHooksPath,
  HOOKS_FEATURE_LINE,
  readCodexConfig,
  trustKey,
} from "./codex";
import {
  buildOpencodePlugin,
  opencodePluginPath,
  readOpencodePlugin,
} from "./opencode";
import {
  deleteHookSecret,
  readHookSecret,
  secretStoreAvailable,
  writeHookSecret,
} from "./secret";

/** Where this copy of the app runs from, for `shimRefusal`. */
function installFacts(): InstallFacts {
  return {
    packaged: app.isPackaged,
    execPath: process.execPath,
    platform: process.platform,
    home: homedir(),
    appHomeOverride: Boolean(process.env.LANEWORK_HOME),
    appImage: Boolean(process.env.APPIMAGE),
  };
}
// At load, before `registerAuth` or `registerAgentSetup` sync anything.
setInstallFacts(installFacts);

/** Where the hook keeps its per-session state. The hook names it too. */
const HOOK_STATE_DIR = join(homedir(), ".cache", "lanework", "checkpoint");

const hooksDir = () => join(appHomeDir(), "hooks");
const shimPath = () => join(hooksDir(), "lanework-checkpoint");
const configPath = () => join(hooksDir(), "config.json");

/**
 * What the app remembers about the hooks, beside them.
 *
 * - `pushWip` is read by the hook itself (FE-29/D3: a setting, not a flag in
 *   an approved command). `pushWipUntracked` adds new, non-ignored files to
 *   that snapshot (FE-78/D9); without it only tracked changes go.
 * - `installed` is what makes "another tool removed ours" (FE-29/D8)
 *   knowable. Without it, removed and never added look alike.
 */
type HookConfig = {
  pushWip: boolean;
  pushWipUntracked: boolean;
  installed: Partial<Record<HookAgent, boolean>>;
};

async function readConfig(): Promise<HookConfig> {
  const raw = await readFile(configPath(), "utf8")
    .then((text) => JSON.parse(text) as Partial<HookConfig>)
    .catch(() => ({}) as Partial<HookConfig>);
  return {
    pushWip: raw.pushWip === true,
    pushWipUntracked: raw.pushWipUntracked === true,
    installed:
      raw.installed && typeof raw.installed === "object" ? raw.installed : {},
  };
}

async function writeConfig(config: HookConfig): Promise<void> {
  await mkdir(hooksDir(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Every CLI the hook runs for. */
const HOOK_AGENTS: readonly HookAgent[] = ["claude-code", "codex", "opencode"];

/** OpenCode's plugin file: the test's fake home in a dev build (FE-104). */
const opencodePlugin = () =>
  opencodePluginPath(opencodeConfigDir(agentHomeDir()));

/** Whether any CLI has the hook on: the credential and push-wip need one. */
const anyInstalled = (config: HookConfig) =>
  HOOK_AGENTS.some((agent) => config.installed[agent] === true);

const settingsPathFor = (agent: Exclude<HookAgent, "opencode">) =>
  agent === "codex" ? codexHooksPath() : claudeSettingsPath();

/**
 * The bundled hook, outside the asar archive.
 *
 * NOTE: `ELECTRON_RUN_AS_NODE` is a plain Node, which cannot read a path
 * inside `app.asar`. `electron-builder.yml` unpacks `dist/electron/hook/**`
 * for that, and this path points at the unpacked copy. Unpackaged (dev,
 * tests) there is no archive, and the path stays as it is.
 */
function hookPath(): string {
  return join(__dirname, "..", "hook", "lanework-checkpoint.cjs").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}

/** Write the shim for this build of the app. Cheap, so every launch does it. */
async function writeShim(record: MachineRecord | null): Promise<void> {
  await mkdir(dirname(shimPath()), { recursive: true, mode: 0o700 });
  await writeFile(
    shimPath(),
    buildShim({
      execPath: process.execPath,
      hookPath: hookPath(),
      apiUrl: resolveApi(record?.apiUrl),
      configPath: configPath(),
      secretFile: process.env.LANEWORK_HOOK_SECRET_FILE || null,
      home: process.env.LANEWORK_HOME || null,
    }),
    { mode: 0o700 },
  );
  await chmod(shimPath(), 0o700);
}

const commandFor = (agent: Exclude<HookAgent, "opencode">) =>
  buildHookCommand({ shimPath: shimPath(), agent });

/** The newest session the hook recorded, from its own state files. */
async function lastCheckpoint(): Promise<HandoffStatus["last"]> {
  const names = await readdir(HOOK_STATE_DIR).catch(() => [] as string[]);
  let best: { taskId: string; at: number } | null = null;
  for (const name of names) {
    if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
    const state = await readFile(join(HOOK_STATE_DIR, name), "utf8")
      .then((text) => JSON.parse(text) as { at?: unknown; taskId?: unknown })
      .catch(() => null);
    if (typeof state?.at !== "number" || typeof state.taskId !== "string")
      continue;
    if (!best || state.at > best.at)
      best = { taskId: state.taskId, at: state.at };
  }
  return best
    ? { taskId: best.taskId, at: new Date(best.at).toISOString() }
    : null;
}

async function agentStatus(
  agent: Exclude<HookAgent, "opencode">,
  config: HookConfig,
): Promise<
  AgentHookStatus & { position: { group: number; index: number } | null }
> {
  const path = settingsPathFor(agent);
  const read = await readSettings(path);
  const installed = read.ok && findHook(read.settings) !== null;
  return {
    installed,
    settingsUnreadable: !read.ok,
    settingsPath: path,
    removedElsewhere: read.ok && !installed && config.installed[agent] === true,
    position: read.ok ? findHookPosition(read.settings) : null,
  };
}

/**
 * OpenCode's hook: our plugin file, running this app home's shim.
 *
 * A file of that name somebody else wrote reads as `settingsUnreadable`: the
 * switch refuses rather than overwrite it.
 */
async function opencodeStatus(config: HookConfig): Promise<AgentHookStatus> {
  const path = opencodePlugin();
  const read = await readOpencodePlugin(path);
  const installed = read.kind === "ours" && read.shimPath === shimPath();
  return {
    installed,
    settingsUnreadable: read.kind === "foreign",
    settingsPath: path,
    removedElsewhere:
      read.kind === "missing" && config.installed.opencode === true,
  };
}

async function handoffStatus(): Promise<HandoffStatus> {
  const record = await readRecord();
  const config = await readConfig();
  const stored = record
    ? await readHookSecret(resolveApi(record.apiUrl))
    : null;
  const { position: _, ...claude } = await agentStatus("claude-code", config);
  const { position, ...codex } = await agentStatus("codex", config);
  const codexConfig = await readCodexConfig();
  return {
    supported: secretStoreAvailable(),
    signedIn: record !== null,
    credential: !!record && stored === record.secret,
    pushWip: config.pushWip,
    pushWipUntracked: config.pushWipUntracked,
    last: await lastCheckpoint(),
    claude,
    opencode: await opencodeStatus(config),
    codex: {
      ...codex,
      hooksEnabled: codexConfig.hooksEnabled,
      approved:
        position !== null &&
        codexConfig.trusted.has(trustKey(codex.settingsPath, position)),
      configPath: codexConfigPath(),
    },
    codexFeatureLine: HOOKS_FEATURE_LINE,
  };
}

async function enable(agent: HookAgent): Promise<HandoffStatus> {
  if (!secretStoreAvailable())
    throw new Error("Handing work between agents needs macOS for now.");
  const refusal = currentShimRefusal();
  if (refusal) throw new Error(shimRefusalMessage(refusal));
  const record = await readRecord();
  // In local mode the hook needs no credential: it writes the checkpoint to
  // the local store for a repo linked to a local board (FE-52/D9).
  if (!record && !(await readLocalMode()))
    throw new Error("Sign in first, so the hook has a credential.");
  if (agent === "opencode") return enableOpencode(record);
  const path = settingsPathFor(agent);
  const read = await readSettings(path);
  if (!read.ok)
    throw new Error(
      `${path} is not valid JSON. Fix or remove it, then try again — Lanework will not overwrite it.`,
    );
  if (record) await writeHookSecret(resolveApi(record.apiUrl), record.secret);
  await writeShim(record);
  // NOTE: Rewritten only when the command differs. For Codex a new command
  // needs a new approval, so re-enabling an entry that is already right must
  // leave the file, and the approval, as they are.
  await updateSettings(
    (settings) =>
      findHook(settings) === commandFor(agent)
        ? null
        : withHook(settings, commandFor(agent)),
    path,
  );
  const config = await readConfig();
  await writeConfig({
    ...config,
    installed: { ...config.installed, [agent]: true },
  });
  return handoffStatus();
}

/**
 * Write our OpenCode plugin (FE-104).
 *
 * Through `updateConfigFile` like every other hook install: atomic, and never
 * over a file that changed under the write. A file of that name that is not
 * ours is refused.
 */
async function enableOpencode(
  record: MachineRecord | null,
): Promise<HandoffStatus> {
  const path = opencodePlugin();
  if ((await readOpencodePlugin(path)).kind === "foreign")
    throw new Error(
      `${path} was not written by Lanework. Move or remove it, then try again — Lanework will not overwrite it.`,
    );
  if (record) await writeHookSecret(resolveApi(record.apiUrl), record.secret);
  await writeShim(record);
  const plugin = buildOpencodePlugin(shimPath());
  await mkdir(dirname(path), { recursive: true });
  await updateConfigFile(path, (text) => (text === plugin ? null : plugin));
  const config = await readConfig();
  await writeConfig({
    ...config,
    installed: { ...config.installed, opencode: true },
  });
  return handoffStatus();
}

async function disable(agent: HookAgent): Promise<HandoffStatus> {
  if (agent === "opencode") {
    // Only our own file goes; one somebody else wrote stays.
    const path = opencodePlugin();
    if ((await readOpencodePlugin(path)).kind === "ours")
      await rm(path, { force: true });
  } else {
    const path = settingsPathFor(agent);
    const read = await readSettings(path);
    if (read.ok && findHook(read.settings) !== null)
      await updateSettings(
        (settings) =>
          findHook(settings) === null ? null : withoutHook(settings),
        path,
      );
  }
  const config = await readConfig();
  const installed = { ...config.installed, [agent]: false };
  await writeConfig({ ...config, installed });
  // The credential goes once no CLI uses it any more.
  if (!anyInstalled({ ...config, installed })) {
    const record = await readRecord();
    await deleteHookSecret(resolveApi(record?.apiUrl));
  }
  return handoffStatus();
}

/**
 * Ask before the hook starts pushing uncommitted work (FE-78/D4).
 *
 * The switch publishes code the person has not committed, to a ref on their
 * remote, on every agent turn, so turning it on is said out loud once.
 *
 * NOTE: An unpackaged app booted by the test suite cannot answer a native
 * dialog and would wait on it forever; there the answer is yes, so the
 * settings spec still exercises the switch. A packaged app always asks.
 *
 * @returns Whether the person chose to turn it on.
 */
async function confirmPushWip(): Promise<boolean> {
  if (!app.isPackaged && process.env.LANEWORK_TEST_USER_DATA) return true;
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Cancel", "Push work in progress"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Push uncommitted work to your git remote?",
    detail: [
      "After each agent turn, the checkpoint hook snapshots the repository's uncommitted work and force-pushes it to refs/lanework/wip/<task-id> on origin. Your branch, index and history are not touched.",
      "",
      'The snapshot includes changes to files git already tracks. New files stay on this machine unless you also turn on "Include new files".',
      "",
      "Anyone who can read that remote can fetch the ref and see that work, even before you commit it.",
    ].join("\n"),
  };
  const parent = BrowserWindow.getFocusedWindow();
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

async function setPushWip(on: boolean): Promise<HandoffStatus> {
  const config = await readConfig();
  if (!anyInstalled(config))
    throw new Error("Turn on handing work between agents first.");
  // Cancel leaves the switch off; the status says so and the UI follows it.
  if (on && !config.pushWip && !(await confirmPushWip()))
    return handoffStatus();
  await writeConfig({ ...(await readConfig()), pushWip: on });
  return handoffStatus();
}

/** Ask before new files join the pushed snapshot (FE-78/D9). */
async function confirmPushWipUntracked(): Promise<boolean> {
  if (!app.isPackaged && process.env.LANEWORK_TEST_USER_DATA) return true;
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Cancel", "Include new files"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Also push new files?",
    detail: [
      "New files that git does not ignore join the snapshot pushed to refs/lanework/wip/<task-id>. A .env.local or a key file that .gitignore misses would go too.",
      "",
      "The hook skips a push when a file name looks like a secret or an added line holds one, but it cannot catch every secret.",
    ].join("\n"),
  };
  const parent = BrowserWindow.getFocusedWindow();
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

async function setPushWipUntracked(on: boolean): Promise<HandoffStatus> {
  const config = await readConfig();
  if (!config.pushWip)
    throw new Error("Turn on pushing work in progress first.");
  if (on && !config.pushWipUntracked && !(await confirmPushWipUntracked()))
    return handoffStatus();
  await writeConfig({ ...(await readConfig()), pushWipUntracked: on });
  return handoffStatus();
}

/**
 * Delete the hook's copy of the credential, after a sign-out.
 *
 * The hooks stay installed and log "no credential" until someone signs in
 * again, when {@link syncHandoff} hands them the new one.
 */
export async function forgetHookCredential(apiUrl: string): Promise<void> {
  await deleteHookSecret(resolveApi(apiUrl)).catch(() => undefined);
}

/**
 * Delete the hook's repo → board cache (FE-78/D5, SS-05).
 *
 * The hook caches which board a repo's remote resolves to and never asks
 * again, so after a sign-out (or a switch to local mode) it would keep
 * writing checkpoints to boards of the account that left. Called on both.
 */
export async function forgetBoardsCache(): Promise<void> {
  await rm(join(HOOK_STATE_DIR, "boards.json"), { force: true }).catch(
    () => undefined,
  );
}

/**
 * Bring installed hooks up to date.
 *
 * That means the shim for this build, this machine's current credential, and,
 * once, an entry from before the shim, which named the binary directly. A
 * no-op when both switches are off.
 *
 * NOTE: Never re-adds an entry another tool removed (FE-29/D8). A tool that
 * owns a settings file and rewrites it on its own schedule would otherwise
 * fight this app over it on every launch. Settings shows the removal instead.
 */
export async function syncHandoff(): Promise<void> {
  if (!secretStoreAvailable()) return;
  // Not a stable install: the installed copy keeps the shim pointed at itself
  // (INF-05, GAP-02).
  if (currentShimRefusal()) return;
  const config = await readConfig();
  const present: HookAgent[] = [];
  for (const agent of ["claude-code", "codex"] as const) {
    const path = settingsPathFor(agent);
    const read = await readSettings(path);
    if (!read.ok) continue;
    const current = findHook(read.settings);
    if (current === null) continue;
    // NOTE: Touch only our own hook: the one that runs this app home's shim,
    // or an entry from before shims existed (it named the binary directly, so
    // it carries `ELECTRON_RUN_AS_NODE=1`). An entry that runs another home's
    // shim belongs to another install of this app: a second copy, or a test
    // run with its own `LANEWORK_HOME`. Repointing it at ours once let a test
    // run take over a user's real `~/.claude` and `~/.codex`.
    const mine = current === commandFor(agent);
    const legacy = current.includes("ELECTRON_RUN_AS_NODE=1");
    if (!mine && !legacy) continue;
    present.push(agent);
    if (legacy)
      await updateSettings(
        (settings) =>
          findHook(settings)?.includes("ELECTRON_RUN_AS_NODE=1")
            ? withHook(settings, commandFor(agent))
            : null,
        path,
      );
  }
  // OpenCode's plugin (FE-104): ours only when it runs this app home's shim;
  // one that runs another home's belongs to that install. Rewritten when an
  // older build of the app wrote it differently.
  const plugin = await readOpencodePlugin(opencodePlugin());
  const pluginNow = buildOpencodePlugin(shimPath());
  if (plugin.kind === "ours" && plugin.shimPath === shimPath()) {
    present.push("opencode");
    if (plugin.text !== pluginNow)
      await updateConfigFile(opencodePlugin(), (text) =>
        text === plugin.text ? pluginNow : null,
      );
  }
  if (!present.length) return;
  const record = await readRecord();
  await writeShim(record);
  const installed = { ...config.installed };
  for (const agent of present) installed[agent] = true;
  await writeConfig({ ...config, installed });
  if (!record) return;
  const account = resolveApi(record.apiUrl);
  if ((await readHookSecret(account)) !== record.secret)
    await writeHookSecret(account, record.secret);
}

const isAgent = (value: unknown): value is HookAgent =>
  value === "claude-code" || value === "codex" || value === "opencode";

/**
 * Offer to move a packaged macOS app that runs from anywhere but an
 * Applications folder (INF-05, GAP-02): a DMG, Downloads, a translocated
 * copy. From there it installs no agent hooks or offline MCP server.
 *
 * NOTE: Not under a test run, which launches the packaged build from
 * `release/` and cannot answer a dialog.
 */
async function offerMoveToApplications(): Promise<void> {
  if (
    process.platform !== "darwin" ||
    !app.isPackaged ||
    process.env.LANEWORK_TEST_USER_DATA ||
    app.isInApplicationsFolder()
  )
    return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: "Move Lanework to the Applications folder?",
    detail:
      "Lanework is running from outside Applications, so it cannot install the checkpoint hook or the offline MCP server for Claude Code and Codex. Moving it fixes that; Lanework restarts from there.",
  });
  // Moves, then relaunches from Applications; quits this copy on success.
  if (response === 0) app.moveToApplicationsFolder();
}

export function registerHandoff(devUrl?: string): void {
  void offerMoveToApplications().catch((error: unknown) =>
    console.warn("could not move Lanework to Applications", error),
  );
  handle(handoffChannels.status, devUrl, (args) => {
    if (args.length) throw new Error("This operation takes no arguments");
    return handoffStatus();
  });
  handle(handoffChannels.enable, devUrl, (args) => {
    if (args.length !== 1 || !isAgent(args[0]))
      throw new Error('enable takes "claude-code", "codex" or "opencode"');
    return enable(args[0]);
  });
  handle(handoffChannels.disable, devUrl, (args) => {
    if (args.length !== 1 || !isAgent(args[0]))
      throw new Error('disable takes "claude-code", "codex" or "opencode"');
    return disable(args[0]);
  });
  handle(handoffChannels.setPushWip, devUrl, (args) => {
    if (args.length !== 1 || typeof args[0] !== "boolean")
      throw new Error("push-wip takes one boolean");
    return setPushWip(args[0]);
  });
  handle(handoffChannels.setPushWipUntracked, devUrl, (args) => {
    if (args.length !== 1 || typeof args[0] !== "boolean")
      throw new Error("push-wip-untracked takes one boolean");
    return setPushWipUntracked(args[0]);
  });
  void syncHandoff().catch((error: unknown) =>
    console.warn("could not bring the agent hooks up to date", error),
  );
}
