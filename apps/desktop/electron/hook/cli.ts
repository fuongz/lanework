// `lanework`: the command that switches the checkpoint hook on for someone
// with Claude Code and no desktop app. It ships in the plugin's `bin/`, so it
// is on PATH inside a Claude session: `! lanework login`.
//
//   lanework login [--device]    sign this machine in (browser, or a code)
//   lanework status              signed in? hook config? last checkpoint?
//   lanework logout              revoke this machine and forget it
//   lanework config push-wip on|off
//   lanework config push-wip-untracked on|off
//   lanework mcp                 the offline board's MCP server, on stdio
//
// NOTE: Sign-in reuses the control plane's `lanework login` flow (its contract
// is `@lanework/protocol`'s `auth.ts`) and the desktop app's own client for
// it, so the two never disagree about PKCE, state or the callback. It never
// takes a pasted registration token (INF-03/D7): it uses a browser on this
// machine (loopback), or a short code typed on another one (device).
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MachineCredential, paths } from "@lanework/protocol";
import {
  machineFacts,
  redeem,
  startDevice,
  startLoopback,
} from "../main/auth/client";
import { listenForCallback } from "../main/auth/loopback";
import { newState, pkcePair } from "../main/auth/pkce";
import { CALLBACK_PATH } from "../main/auth/redirect";
import { runLocalMcpServer } from "../mcp-local/index";
import {
  configDir,
  credentialLocation,
  deleteSecret,
  readSecret,
  writeSecret,
} from "./credential";

/**
 * The plugin's settings file.
 *
 * It plays the part the file `LANEWORK_HOOK_CONFIG` names plays for the app.
 */
export const pluginConfigPath = () => join(configDir(), "hook.json");

/**
 * What the hook reads from the plugin's settings file.
 *
 * `pushWipUntracked` adds new files to the WIP snapshot; it means nothing
 * without `pushWip` (FE-78/D9).
 */
type PluginConfig = { pushWip?: boolean; pushWipUntracked?: boolean };

function readConfig(): PluginConfig {
  try {
    return JSON.parse(readFileSync(pluginConfigPath(), "utf8")) as PluginConfig;
  } catch {
    return {};
  }
}

function openBrowser(url: string): boolean {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "linux"
        ? "xdg-open"
        : null;
  if (!opener) return false;
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** No display on Linux usually means SSH: no browser to open here. */
const headless = () =>
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY;

async function loginLoopback(api: string): Promise<MachineCredential> {
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const code = await listenForCallback({
    state,
    onPort: async (port) => {
      const started = await startLoopback(api, {
        challenge,
        state,
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        facts: machineFacts(),
      });
      const opened = openBrowser(started.authorizeUrl);
      console.log(
        opened
          ? "Opened your browser — approve this machine there."
          : `Open this link and approve this machine:\n  ${started.authorizeUrl}`,
      );
    },
  });
  const outcome = await redeem(api, { code }, verifier);
  if (outcome.state !== "issued")
    throw new Error(`Sign-in was not completed (${outcome.state}).`);
  return outcome;
}

/**
 * How long a device code lives on the server.
 *
 * Matches `CliAuthDeviceResponse.expires_in`.
 */
const DEVICE_TTL_MS = 10 * 60 * 1000;

type PendingDevice = {
  api: string;
  deviceCode: string;
  verifier: string;
  interval: number;
  deadline: number;
};

/** Say what the hook will actually do with a credential just saved. */
function outcome(): string {
  // A `--force` beside the desktop app, or a credential file named only in
  // this shell, change the answer from the plain case.
  return desktopHookInstalled()
    ? "The desktop app's hook is the one that runs on this machine, so this plugin's hook stays quiet and keeps not using this credential."
    : process.env.LANEWORK_HOOK_SECRET_FILE
      ? "The hook uses this credential only if LANEWORK_HOOK_SECRET_FILE is also set where Claude Code runs; otherwise it keeps using its usual one."
      : "Claude Code will now leave a checkpoint on the card after every turn.";
}

function save(api: string, issued: MachineCredential) {
  writeSecret(api, issued.secret);
  if (readSecret(api) !== issued.secret)
    throw new Error("Signed in, but the credential could not be read back.");
  return `Signed in as machine ${issued.machineId}. Saved to ${credentialLocation(api)}.\n${outcome()}`;
}

/**
 * Start a device sign-in, print the code, and return.
 *
 * NOTE: The wait for approval runs in a detached process, not here. Claude
 * Code shows a `!` command's output only once the command ends, so a login
 * that polled here would show its code to nobody, and past 120s Claude Code
 * moves it to the background, still waiting. The poller gets the PKCE
 * verifier in a 0600 file it deletes on start, and gives up when the code
 * expires.
 */
async function startDeviceLogin(api: string, stateDir: string): Promise<void> {
  const { verifier, challenge } = pkcePair();
  const started = await startDevice(api, { challenge, facts: machineFacts() });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, `device-${process.pid}-${Date.now()}.json`);
  const pending: PendingDevice = {
    api,
    deviceCode: started.deviceCode,
    verifier,
    interval: started.interval,
    deadline: Date.now() + DEVICE_TTL_MS,
  };
  writeFileSync(file, JSON.stringify(pending), { mode: 0o600 });
  // Same binary, same flags, same environment (a LANEWORK_HOOK_SECRET_FILE
  // included), so the credential lands where this command would have put it.
  spawn(
    process.execPath,
    [process.argv[1] ?? "", "--plugin", "login-wait", file],
    { detached: true, stdio: "ignore" },
  ).unref();
  console.log(
    [
      `On any device, open ${started.verificationUri} and enter the code:`,
      "",
      `    ${started.userCode}`,
      "",
      "Signing in finishes by itself once you approve (the code lasts 10 minutes).",
      "Then check with: lanework status",
    ].join("\n"),
  );
}

/** The detached half of a device sign-in: poll, save, and log the outcome. */
export async function waitForDeviceLogin(
  file: string,
  stateDir: string,
): Promise<void> {
  const note = (line: string) => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      appendFileSync(
        join(stateDir, "hook.log"),
        `${new Date().toISOString()} device sign-in: ${line}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Nowhere left to report to.
    }
  };
  let pending: PendingDevice;
  try {
    pending = JSON.parse(readFileSync(file, "utf8")) as PendingDevice;
  } finally {
    rmSync(file, { force: true });
  }
  let interval = pending.interval;
  while (Date.now() < pending.deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const result = await redeem(
      pending.api,
      { deviceCode: pending.deviceCode },
      pending.verifier,
    ).catch((error: unknown) => {
      note(`failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!result) return;
    if (result.state === "issued") {
      note(save(pending.api, result).split("\n")[0] ?? "signed in");
      return;
    }
    if (result.state === "slow_down") interval += 5;
    else if (result.state === "denied") return note("denied");
    else if (result.state === "expired") return note("the code expired");
  }
  note("the code expired before it was approved");
}

export async function login(
  api: string,
  device: boolean,
  force: boolean,
  stateDir: string,
): Promise<void> {
  // NOTE: The desktop app keeps its own credential in the same Keychain item.
  // Signing in here would overwrite it with a second machine's, the app would
  // write its own back on its next launch, and the one issued here would stay
  // enrolled and unused. With the app's hook installed there is nothing to do.
  if (!force && desktopHookInstalled()) {
    console.log(
      "The Lanework desktop app already signed this machine in and runs the hook (Settings → Harness). Nothing to do.\nUse `lanework login --force` to sign in separately anyway.",
    );
    return;
  }
  if (device || headless()) return startDeviceLogin(api, stateDir);
  console.log(save(api, await loginLoopback(api)));
}

export async function logout(api: string): Promise<void> {
  const secret = readSecret(api);
  if (!secret) {
    console.log("Not signed in.");
    return;
  }
  // Best effort, like the desktop app's sign-out: the local copy goes either
  // way, so a network failure never strands someone who asked to leave.
  const revoked = await fetch(`${api}${paths.machinesMe()}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5_000),
  })
    .then((res) => res.ok)
    .catch(() => false);
  deleteSecret(api);
  console.log(
    revoked
      ? "Signed out and revoked this machine."
      : `Signed out here. The control plane could not be reached — revoke this machine at ${api}/setup.`,
  );
}

export async function status(
  api: string,
  stateDir: string,
  desktopHook: boolean,
): Promise<void> {
  const secret = readSecret(api);
  let signedIn = "no — run `lanework login`";
  if (secret) {
    const res = await fetch(`${api}${paths.machinesMe()}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    signedIn = !res
      ? "yes (control plane unreachable, not verified)"
      : res.ok
        ? "yes"
        : res.status === 401
          ? "no — this machine was revoked; run `lanework login`"
          : `unknown (HTTP ${res.status})`;
  }
  let last = "none yet";
  try {
    let best: { at: number; taskId: string } | null = null;
    for (const name of readdirSync(stateDir)) {
      if (!name.startsWith("session-")) continue;
      const s = JSON.parse(readFileSync(join(stateDir, name), "utf8")) as {
        at?: number;
        taskId?: string;
      };
      if (typeof s.at === "number" && s.taskId && (!best || s.at > best.at))
        best = { at: s.at, taskId: s.taskId };
    }
    if (best) last = `${best.taskId} at ${new Date(best.at).toLocaleString()}`;
  } catch {
    // No state yet.
  }
  console.log(
    [
      `API:              ${api}`,
      `Signed in:        ${signedIn}`,
      `Credential:       ${credentialLocation(api)}`,
      `Push unfinished:  ${readConfig().pushWip ? "on" : "off"} (lanework config push-wip on|off)`,
      `  with new files: ${readConfig().pushWipUntracked ? "on" : "off"} (lanework config push-wip-untracked on|off)`,
      `Last checkpoint:  ${last}`,
      ...(desktopHook
        ? [
            "Desktop app:      its hook is installed, so this plugin's hook stays quiet (one checkpoint per turn)",
          ]
        : []),
      `Log:              ${join(stateDir, "hook.log")}`,
    ].join("\n"),
  );
}

/** What `lanework config <key> on|off` sets, and what the hook then does. */
const CONFIG_KEYS = {
  "push-wip": {
    field: "pushWip",
    on: "The hook will also push uncommitted changes to tracked files to refs/lanework/wip/<task id>. New files go too only with `lanework config push-wip-untracked on`. Anyone who can read the remote can fetch that ref.",
    off: "The hook will not push code.",
  },
  "push-wip-untracked": {
    field: "pushWipUntracked",
    on: "When it pushes unfinished work, the hook will also include new files that are not ignored. Anyone who can read the remote can fetch that ref. A snapshot that looks like it holds a secret (an .env or key file, or a token in an added line) is never pushed.",
    off: "When it pushes unfinished work, the hook will include changes to tracked files only.",
  },
} as const;

export function config(
  key: string | undefined,
  value: string | undefined,
): void {
  const entry =
    key && Object.hasOwn(CONFIG_KEYS, key)
      ? CONFIG_KEYS[key as keyof typeof CONFIG_KEYS]
      : null;
  if (!entry || (value !== "on" && value !== "off")) {
    console.error(
      "usage: lanework config push-wip on|off\n       lanework config push-wip-untracked on|off",
    );
    process.exitCode = 1;
    return;
  }
  const next: PluginConfig = { ...readConfig(), [entry.field]: value === "on" };
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pluginConfigPath(), `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  const said = value === "on" ? entry.on : entry.off;
  console.log(
    entry.field === "pushWipUntracked" && value === "on" && !next.pushWip
      ? `${said}\nNothing is pushed until \`lanework config push-wip on\`.`
      : said,
  );
}

/**
 * Whether the desktop app's hook is installed for Claude Code.
 *
 * When it is, the plugin's own hook stands down, or every turn would be
 * checkpointed twice (INF-03/D8).
 */
export function desktopHookInstalled(): boolean {
  const settings = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
  if (!existsSync(settings)) return false;
  try {
    return readFileSync(settings, "utf8").includes("lanework-checkpoint");
  } catch {
    return false;
  }
}

/**
 * `lanework mcp`: the offline board's MCP server on stdio.
 *
 * For an agent config that names this command instead of the app's bundle.
 * It is the app's server, on the app's file (`~/.lanew/data.sqlite`, or
 * `LANEWORK_HOME`).
 *
 * NOTE: stdout is the protocol channel while it runs: print nothing here.
 */
export function mcp(): Promise<void> {
  return runLocalMcpServer();
}
