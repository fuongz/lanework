// Harness updates: which version of Claude Code and Codex this machine runs,
// whether a newer one is out, and updating it from the app.
//
// NOTE: The renderer names an agent, never a command. `rules.ts` chooses every
// command run here from where the binary really lives, so no window can make
// this process run a command line of its own.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import {
  type HarnessAgent,
  type HarnessInfo,
  harnessChannels,
  type InstallMethod,
} from "../../../shared/harness";
import { TERMINAL_AGENTS } from "../../../shared/terminal";
import { broadcast, handle } from "../ipc";
import { defaultShell } from "../terminal/shell-env";
import { agentHomeDir } from "../test-seams";
import { writeAtomic } from "../workspaces/store";
import { harnessAccounts } from "./accounts";
import { latestVersion } from "./latest";
import { probeAgent } from "./probe";
import {
  cleanVersion,
  failureMessage,
  installMethodOf,
  shQuote,
  terminalScript,
  updateCommandOf,
} from "./rules";
import { runInLoginShell } from "./shell";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** `brew upgrade` refreshes its taps first, which alone can take minutes. */
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const UPDATE_MARKER = "__lanework_harness_update__";

/**
 * Whether this is a test run, where the test switches below apply.
 *
 * Only a spec sets `LANEWORK_TEST_USER_DATA`, as for the terminal host. The
 * switches:
 *
 * - `LANEWORK_<AGENT>_BIN`: the CLI, a stand-in that answers `--version` and
 *   `update`. Without one the agent reads as not installed.
 * - `LANEWORK_HARNESS_METHOD_<AGENT>`: how it was "installed" (default
 *   `native`).
 * - `LANEWORK_HARNESS_LATEST_<AGENT>`: the latest version.
 *
 * Nothing goes to the network or to brew in a test run, and Terminal is never
 * opened.
 */
const testing = () =>
  !app.isPackaged && Boolean(process.env.LANEWORK_TEST_USER_DATA);
const testEnv = (agent: HarnessAgent, name: "BIN" | "METHOD" | "LATEST") =>
  process.env[
    name === "BIN"
      ? `LANEWORK_${agent.toUpperCase()}_BIN`
      : `LANEWORK_HARNESS_${name}_${agent.toUpperCase()}`
  ] || undefined;
const METHODS: readonly InstallMethod[] = [
  "native",
  "brew-cask",
  "brew-formula",
  "npm",
  "unknown",
];

type Entry = HarnessInfo;

const entries = new Map<HarnessAgent, Entry>(
  TERMINAL_AGENTS.map((agent) => [
    agent,
    {
      agent,
      path: null,
      version: null,
      latest: null,
      installMethod: "unknown",
      updateCommand: null,
      dismissed: null,
      update: { state: "idle" },
      checkedAt: null,
    },
  ]),
);

function list(): HarnessInfo[] {
  return TERMINAL_AGENTS.map((agent) => {
    const entry = entries.get(agent) as Entry;
    return { ...entry, update: { ...entry.update } };
  });
}

function changed(): HarnessInfo[] {
  const current = list();
  broadcast(harnessChannels.changed, current);
  return current;
}

// ── Dismissed versions ────────────────────────────────────────────────────

/**
 * The file that keeps each agent's dismissed version.
 *
 * One exact version per agent (FE-61/D9): closing the island on 2.1.302 hides
 * 2.1.302 only, and 2.1.303 brings it back.
 */
const dismissedFile = () => join(app.getPath("userData"), "harness.json");

async function loadDismissed(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(dismissedFile(), "utf8")) as {
      dismissed?: Record<string, unknown>;
    };
    for (const [agent, entry] of entries)
      entry.dismissed = cleanVersion(raw.dismissed?.[agent]);
  } catch {
    // None yet, or unreadable: nothing is dismissed.
  }
}

async function saveDismissed(): Promise<void> {
  const dismissed: Record<string, string> = {};
  for (const [agent, entry] of entries)
    if (entry.dismissed) dismissed[agent] = entry.dismissed;
  await writeAtomic(
    dismissedFile(),
    `${JSON.stringify({ v: 1, dismissed }, null, 2)}\n`,
  );
}

// ── Checking ──────────────────────────────────────────────────────────────

/** The shell word that runs this CLI, or null when a test says it has none. */
function commandFor(agent: HarnessAgent): string | null {
  if (!testing()) return agent;
  const bin = testEnv(agent, "BIN");
  return bin ? shQuote(bin) : null;
}

async function probeOne(agent: HarnessAgent): Promise<void> {
  const entry = entries.get(agent) as Entry;
  const command = commandFor(agent);
  const found = command
    ? await probeAgent(agent, { command })
    : { path: null, version: null, answered: true };
  // A shell that timed out has not said the CLI is gone. What the last probe
  // found stands until one answers.
  if (!found.answered && entry.path !== null) return;
  entry.path = found.path;
  entry.version = found.version;
  if (testing()) {
    const method = testEnv(agent, "METHOD") as InstallMethod;
    entry.installMethod =
      found.path === null
        ? "unknown"
        : METHODS.includes(method)
          ? method
          : "native";
    entry.updateCommand =
      entry.installMethod === "unknown" || !command
        ? null
        : `${command} update`;
    return;
  }
  entry.installMethod = installMethodOf(agent, found.path, homedir());
  entry.updateCommand = updateCommandOf(agent, entry.installMethod, found.path);
}

async function checkOne(agent: HarnessAgent): Promise<void> {
  const entry = entries.get(agent) as Entry;
  await probeOne(agent);
  entry.latest =
    entry.version === null
      ? null
      : testing()
        ? cleanVersion(testEnv(agent, "LATEST"))
        : await latestVersion(
            agent,
            entry.installMethod,
            entry.path,
            entry.version,
          );
  entry.checkedAt = new Date().toISOString();
}

let checking: Promise<HarnessInfo[]> | null = null;

/**
 * Probe every CLI and look up its latest version.
 *
 * A check already running is shared.
 */
function check(): Promise<HarnessInfo[]> {
  checking ??= Promise.all(TERMINAL_AGENTS.map(checkOne))
    .then(changed)
    .finally(() => {
      checking = null;
    });
  return checking;
}

// ── Updating ──────────────────────────────────────────────────────────────

/**
 * Run the update command hidden in the user's login shell.
 *
 * NOTE: One at a time per agent. A second click while it runs is a no-op, not
 * a second `brew upgrade` racing the first over the same Caskroom.
 *
 * @throws When the app cannot tell how to update this CLI.
 */
function update(agent: HarnessAgent): HarnessInfo[] {
  const entry = entries.get(agent) as Entry;
  if (entry.update.state === "updating") return list();
  const command = entry.updateCommand;
  if (!command) throw new Error("The app cannot tell how to update this CLI.");
  entry.update = { state: "updating" };
  void (async () => {
    // A marker on stderr too: what the profile printed there before it is
    // not the update's failure.
    const result = await runInLoginShell(
      `printf '\\n%s\\n' '${UPDATE_MARKER}' >&2; ${command}`,
      { timeoutMs: UPDATE_TIMEOUT_MS },
    );
    if (result.code === 0) {
      await probeOne(agent).catch(() => {});
      entry.update = { state: "done", version: entry.version ?? "" };
    } else {
      const at = result.stderr.lastIndexOf(UPDATE_MARKER);
      const stderr =
        at < 0 ? "" : result.stderr.slice(at + UPDATE_MARKER.length);
      entry.update = {
        state: "failed",
        message: failureMessage(stderr, result.stdout, result.code),
      };
    }
    changed();
  })();
  return changed();
}

/**
 * Run the update command in Terminal, where its output can be read.
 *
 * A `.command` file that Terminal opens. Not the app's own terminal tabs:
 * those belong to a workspace, and the app never types a command into one.
 * Not AppleScript either, which would ask for Automation permission.
 *
 * NOTE: The file holds only the command `rules.ts` chose, and only this user
 * can read or run it.
 *
 * @throws When the app cannot tell how to update this CLI, or Terminal does
 *   not open.
 */
async function openInTerminal(agent: HarnessAgent): Promise<void> {
  const command = (entries.get(agent) as Entry).updateCommand;
  if (!command) throw new Error("The app cannot tell how to update this CLI.");
  const dir = join(app.getPath("userData"), "harness");
  const file = join(dir, `update-${agent}.command`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, terminalScript(defaultShell().file, command), {
    mode: 0o700,
  });
  // NOTE: `mode` applies only when the file is created. An older file keeps
  // whatever mode it had.
  await chmod(file, 0o700);
  if (testing()) return;
  const error = await shell.openPath(file);
  if (error) throw new Error(`Could not open Terminal: ${error}`);
}

// ── IPC ───────────────────────────────────────────────────────────────────

function agentArg(value: unknown): HarnessAgent {
  if (!(TERMINAL_AGENTS as readonly unknown[]).includes(value))
    throw new Error("Unknown agent");
  return value as HarnessAgent;
}

export function registerHarness(devUrl?: string): void {
  const ready = loadDismissed();
  handle(harnessChannels.accounts, devUrl, (args) => {
    if (args.length) throw new Error("accounts takes no arguments");
    return harnessAccounts(agentHomeDir());
  });
  handle(harnessChannels.list, devUrl, async (args) => {
    if (args.length) throw new Error("list takes no arguments");
    await ready;
    return list();
  });
  handle(harnessChannels.check, devUrl, async (args) => {
    if (args.length) throw new Error("check takes no arguments");
    await ready;
    return check();
  });
  handle(harnessChannels.update, devUrl, async (args) => {
    if (args.length !== 1) throw new Error("update takes one agent");
    await ready;
    return update(agentArg(args[0]));
  });
  handle(harnessChannels.dismiss, devUrl, async (args) => {
    if (args.length !== 2)
      throw new Error("dismiss takes an agent and a version");
    const agent = agentArg(args[0]);
    const version = cleanVersion(args[1]);
    if (version === null || version !== args[1])
      throw new Error("dismiss takes a version");
    await ready;
    (entries.get(agent) as Entry).dismissed = version;
    await saveDismissed();
    return changed();
  });
  handle(harnessChannels.openInTerminal, devUrl, async (args) => {
    if (args.length !== 1) throw new Error("openInTerminal takes one agent");
    await ready;
    return openInTerminal(agentArg(args[0]));
  });
  // On launch, then every 6 hours. The island's own check is on demand.
  void ready.then(check).catch(() => {});
  setInterval(() => void check().catch(() => {}), CHECK_EVERY_MS).unref();
}
