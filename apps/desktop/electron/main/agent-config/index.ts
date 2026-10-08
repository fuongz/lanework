// Settings → Agents → Config files (FE-47): the user's own Claude Code and
// Codex config, read and written by id. See `files.ts` for how a write is
// kept safe, and `shared/agent-config.ts` for why the text crosses whole.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { app, shell } from "electron";
import {
  agentConfigChannels,
  type ConfigFileId,
  isConfigFileId,
} from "../../../shared/agent-config";
import { agentHome } from "../agent-home";
import { handle } from "../ipc";
import {
  listConfigFiles,
  readConfigFile,
  revealTarget,
  writeConfigFile,
} from "./files";

/** The agents' homes — the test's fake one in a dev build, as FE-40 does. */
function where() {
  return agentHome(
    (!app.isPackaged && process.env.LANEWORK_TEST_AGENT_HOME) || homedir(),
  );
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
    return writeConfigFile(idArg(args[0]), args[1], hashArg(args[2]), where());
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
