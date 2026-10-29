// Settings → Agents → Config files: the user's own Claude Code, Codex and
// OpenCode config, read and written by id. See `files.ts` for how a write is
// kept safe, and `shared/agent-config.ts` for why the text crosses whole.
import { stat } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  dialog,
  type MessageBoxOptions,
  shell,
} from "electron";
import {
  agentConfigChannels,
  type ConfigFileId,
  type ConfigWriteResult,
  isConfigFileId,
} from "../../../shared/agent-config";
import { agentHome } from "../agent-home";
import { handle } from "../ipc";
import { agentHomeDir } from "../test-seams";
import {
  listConfigFiles,
  pathOf,
  readConfigFile,
  revealTarget,
  shown,
  writeConfigFile,
} from "./files";
import { type RiskyChange, riskyChange } from "./risky-keys";

/**
 * The agents' homes.
 *
 * A dev build takes the test's fake one (`agentHomeDir`), as the agent setup
 * view does.
 */
function where() {
  return agentHome(agentHomeDir());
}

function idArg(value: unknown): ConfigFileId {
  if (!isConfigFileId(value)) throw new Error("That is not a config file.");
  return value;
}

function hashArg(value: unknown): string {
  if (typeof value !== "string" || !/^([0-9a-f]{64})?$/.test(value))
    throw new Error("That file was not read here.");
  return value;
}

/**
 * Ask before a write adds or changes a command the agent runs on its own
 * (FE-81/D1), with the focused window as the dialog's parent.
 *
 * NOTE: An unpackaged app booted by the test suite cannot answer a native
 * dialog and would wait on it forever; there the answer is yes, as for the
 * handoff switches. A packaged app always asks.
 *
 * @returns Whether the person chose to save.
 */
async function confirmRisky(
  id: ConfigFileId,
  change: RiskyChange,
): Promise<boolean> {
  if (!app.isPackaged && process.env.LANEWORK_TEST_USER_DATA) return true;
  // The path as the list shows it, so OpenCode's `.json` or `.jsonc` and a
  // moved agent home are named as they are (FE-105/D1).
  const home = where();
  const file = shown(pathOf(id, home), home.home);
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Cancel", "Save"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Save commands the agent will run on its own?",
    detail: [
      `This change to ${file} adds or changes ${change.keys.join(", ")}. The agent runs these by itself, in every project, until they are removed:`,
      "",
      ...change.lines,
      "",
      "Save only if you made this change yourself.",
    ].join("\n"),
  };
  const parent = BrowserWindow.getFocusedWindow();
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * Write a config file, asking first when the write adds or changes a hook,
 * the status line, an API key helper or an MCP server (FE-81/D1).
 *
 * The old text is the one on disk now. When it no longer matches `baseHash`
 * nothing is asked: the write itself refuses it as a conflict.
 */
async function confirmedWrite(
  id: ConfigFileId,
  text: string,
  baseHash: string,
): Promise<ConfigWriteResult> {
  const before = await readConfigFile(id, where());
  if (before.hash === baseHash) {
    const change = riskyChange(id, before.text, text);
    if (change && !(await confirmRisky(id, change)))
      return {
        status: "invalid",
        error: "Not saved: the change to commands was not confirmed.",
      };
  }
  return writeConfigFile(id, text, baseHash, where());
}

/**
 * Register the config files' IPC handlers.
 *
 * Each handler throws to the renderer on arguments it should never send: a
 * wrong count, an unknown file id, or a hash this side never handed out.
 */
export function registerAgentConfig(devUrl?: string): void {
  handle(agentConfigChannels.list, devUrl, (args) => {
    if (args.length) throw new Error("list takes nothing");
    return listConfigFiles(where());
  });
  handle(agentConfigChannels.read, devUrl, (args) => {
    if (args.length !== 1) throw new Error("read takes one file");
    return readConfigFile(idArg(args[0]), where());
  });
  handle(agentConfigChannels.write, devUrl, (args) => {
    if (args.length !== 3)
      throw new Error(
        "write takes a file, its text and the hash it was read at",
      );
    if (typeof args[1] !== "string") throw new Error("The text is required.");
    return confirmedWrite(idArg(args[0]), args[1], hashArg(args[2]));
  });
  handle(agentConfigChannels.reveal, devUrl, async (args) => {
    if (args.length !== 1) throw new Error("reveal takes one file");
    const target = await revealTarget(idArg(args[0]), where());
    const isFile = await stat(target).then(
      (info) => info.isFile(),
      () => false,
    );
    if (isFile) shell.showItemInFolder(target);
    else await shell.openPath(target);
  });
}
