// `lanework` — what someone with Claude Code and no desktop app types to switch
// the checkpoint hook on (INF-03). Shipped in the plugin's `bin/`, so it is on
// PATH inside a Claude session: `! lanework login`.
//
//   lanework login [--device]    sign this machine in (browser, or a code)
//   lanework status              signed in? hook config? last checkpoint?
//   lanework logout              revoke this machine and forget it
//   lanework config push-wip on|off
//
// ⚠️ Sign-in reuses the control plane's `lanework login` flow
// (apps/api/src/routes/cli.ts) and the desktop app's own client for it, so the
// two can never disagree about PKCE, state or the callback. Never a pasted
// registration token (INF-03/D7): a browser on this machine (loopback), or a
// short code typed on another one (device).
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  machineFacts,
  redeem,
  startDevice,
  startLoopback,
} from "../main/auth/client";
import { listenForCallback } from "../main/auth/loopback";
import { newState, pkcePair } from "../main/auth/pkce";
import { CALLBACK_PATH } from "../main/auth/redirect";
import {
  configDir,
  credentialLocation,
  deleteSecret,
  readSecret,
  writeSecret,
} from "./credential";

/** The plugin's settings file — what `LANEWORK_HOOK_CONFIG` names for the app. */
export const pluginConfigPath = () => join(configDir(), "hook.json");

type PluginConfig = { pushWip?: boolean };

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

async function loginLoopback(
  api: string,
): Promise<{ machineId: string; secret: string }> {
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

async function loginDevice(
  api: string,
): Promise<{ machineId: string; secret: string }> {
  const { verifier, challenge } = pkcePair();
  const started = await startDevice(api, { challenge, facts: machineFacts() });
  console.log(
    `On any device, open ${started.verificationUri} and enter the code:\n\n    ${started.userCode}\n`,
  );
  let interval = started.interval;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const outcome = await redeem(
      api,
      { deviceCode: started.deviceCode },
      verifier,
    );
    if (outcome.state === "issued") return outcome;
    if (outcome.state === "slow_down") interval += 5;
    else if (outcome.state === "denied")
      throw new Error("The sign-in was denied.");
    else if (outcome.state === "expired")
      throw new Error("The code expired. Run `lanework login` again.");
  }
}

export async function login(
  api: string,
  device: boolean,
  force = false,
): Promise<void> {
  // ⚠️ The desktop app keeps ITS credential in the same Keychain item. Signing
  // in here would overwrite it with a second machine's, the app would write
  // its own back on its next launch, and the one issued here would be left
  // enrolled and unused. With the app's hook installed there is nothing to do.
  if (!force && desktopHookInstalled()) {
    console.log(
      "The Lanework desktop app already signed this machine in and runs the hook (Settings → Agents). Nothing to do.\nUse `lanework login --force` to sign in separately anyway.",
    );
    return;
  }
  const issued =
    device || headless() ? await loginDevice(api) : await loginLoopback(api);
  writeSecret(api, issued.secret);
  if (readSecret(api) !== issued.secret)
    throw new Error("Signed in, but the credential could not be read back.");
  console.log(
    `Signed in as machine ${issued.machineId}. Saved to ${credentialLocation()}.\nClaude Code will now leave a checkpoint on the card after every turn.`,
  );
}

export async function logout(api: string): Promise<void> {
  const secret = readSecret(api);
  if (!secret) {
    console.log("Not signed in.");
    return;
  }
  // Best effort, like the desktop app's sign-out: the local copy goes either
  // way, so a network failure never strands someone who asked to leave.
  const revoked = await fetch(`${api}/v1/machines/me`, {
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
    const res = await fetch(`${api}/v1/machines/me`, {
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
      `Credential:       ${credentialLocation()}`,
      `Push unfinished:  ${readConfig().pushWip ? "on" : "off"} (lanework config push-wip on|off)`,
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

export function config(
  key: string | undefined,
  value: string | undefined,
): void {
  if (key !== "push-wip" || (value !== "on" && value !== "off")) {
    console.error("usage: lanework config push-wip on|off");
    process.exitCode = 1;
    return;
  }
  const next = { ...readConfig(), pushWip: value === "on" };
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pluginConfigPath(), `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    value === "on"
      ? "The hook will also push uncommitted work to refs/lanework/wip/<task id>."
      : "The hook will not push code.",
  );
}

/**
 * Is the desktop app's hook installed for Claude Code (INF-03/D8)? Then the
 * plugin's own hook stands down, or every turn would be checkpointed twice.
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
