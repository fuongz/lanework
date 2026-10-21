// Which agent CLIs this machine has (FE-19): what the terminal's + menu offers
// beside a plain shell. Runs in the pty host, next to the shells it predicts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { TERMINAL_AGENTS, type TerminalAgent } from "../../../shared/terminal";
import { defaultShell, type ShellChoice, shellEnv } from "./sessions";

interface AgentProbeOptions {
  /** Pin the shell (tests); otherwise `defaultShell()`. */
  shell?: ShellChoice;
  env?: NodeJS.ProcessEnv;
  /** How long a shell that never answers is waited for. */
  timeoutMs?: number;
  /** How long an answer is reused before the shell is asked again. */
  ttlMs?: number;
}

/** Printed by the probe for each CLI it finds; nothing else counts. */
const found = (agent: TerminalAgent) => `__lanework_found_${agent}__`;

/**
 * Ask the user's own shell which agent CLIs it can run.
 *
 * ⚠️ The SHELL is asked, not this process's PATH. An app opened from the Dock
 * has launchd's four-directory PATH, while the tab runs a login shell with
 * the user's whole profile — and Claude's own installer puts `claude` there
 * as an ALIAS in `.zshrc`, which no PATH lookup finds. So it is the tab's
 * shell, login AND interactive, running `command -v`: whatever it finds, a
 * tab can run.
 *
 * ⚠️ A marker per CLI rather than the exit status or "any output": the
 * profile runs first, and a profile is free to print — or to fail on — lines
 * of its own. Its stdin is /dev/null, so a prompt in it reads nothing and
 * moves on instead of holding the probe until it times out.
 *
 * ⚠️ Cached, and asked again only after `ttlMs`: an interactive profile can
 * take a second to load, and the menu is opened far more often than a CLI is
 * installed. A probe already running is shared, not started twice.
 */
export function createAgentProbe(options: AgentProbeOptions = {}) {
  const ttlMs = options.ttlMs ?? 30_000;
  let cached: { at: number; agents: TerminalAgent[] } | null = null;
  let running: Promise<TerminalAgent[]> | null = null;

  function probe(): Promise<TerminalAgent[]> {
    // Out of scope for now (FE-19): a Windows shell has no `command -v`.
    if (process.platform === "win32") return Promise.resolve([]);
    const env = options.env ?? process.env;
    const shell = options.shell ?? defaultShell(env);
    const script = TERMINAL_AGENTS.map(
      (agent) =>
        `command -v ${agent} >/dev/null 2>&1 && printf '%s\\n' '${found(agent)}'`,
    ).join("; ");
    return new Promise((resolve) => {
      let out = "";
      const settle = () => {
        clearTimeout(timer);
        resolve(TERMINAL_AGENTS.filter((agent) => out.includes(found(agent))));
      };
      const child = spawn(shell.file, [...shell.args, "-i", "-c", script], {
        cwd: homedir(),
        env: shellEnv(env),
        stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        options.timeoutMs ?? 8_000,
      );
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
      });
      // A shell that could not start offers nothing but the plain terminal.
      child.once("error", settle);
      child.once("close", settle);
    });
  }

  return function agents(): Promise<TerminalAgent[]> {
    if (cached && Date.now() - cached.at < ttlMs)
      return Promise.resolve(cached.agents);
    running ??= probe()
      .then((agents) => {
        cached = { at: Date.now(), agents };
        return agents;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}

interface ClaudeAuth {
  plan: string | null;
  authMode: string | null;
  loggedIn: boolean;
  identity: string | null;
  /**
   * The signed-in email and organization, for Settings › Harness only
   * (`harness/accounts.ts`). ⚠️ Never put in `ClaudeUsage`, which the footer
   * reads: the usage path copies `plan` and `authMode` by name.
   */
  email: string | null;
  org: string | null;
}
/** Only these public account labels escape the CLI JSON. */
export function claudeAuthOf(value: unknown): ClaudeAuth {
  const empty = {
    plan: null,
    authMode: null,
    loggedIn: false,
    identity: null,
    email: null,
    org: null,
  };
  if (!value || typeof value !== "object") return empty;
  const v = value as Record<string, unknown>;
  const plans = ["pro", "max", "team", "enterprise", "free"];
  const modes = [
    "claude.ai",
    "api_key",
    "api",
    "api_key_helper",
    "third_party",
    "none",
    "bedrock",
    "vertex",
    "foundry",
    "oauth_token",
  ];
  const plan =
    typeof v.subscriptionType === "string" &&
    plans.includes(v.subscriptionType.toLowerCase())
      ? v.subscriptionType.toLowerCase()
      : null;
  const authMode =
    typeof v.authMethod === "string" && modes.includes(v.authMethod)
      ? v.authMethod
      : null;
  // An in-memory fingerprint detects same-plan account switches; never sent
  // over IPC or stored. Credential fields are deliberately never inspected.
  const identifiers = [v.accountUuid, v.orgUuid, v.email].filter(
    (value) => typeof value === "string",
  );
  const identity = identifiers.length
    ? createHash("sha256").update(JSON.stringify(identifiers)).digest("hex")
    : null;
  const text = (field: unknown) =>
    typeof field === "string" && field.trim()
      ? field.trim().slice(0, 200)
      : null;
  return {
    plan,
    authMode,
    loggedIn: v.loggedIn === true,
    identity,
    email: text(v.email),
    org: text(v.orgName),
  };
}

export function createClaudeAuthProbe(options: AgentProbeOptions = {}) {
  let cached: { at: number; auth: ClaudeAuth } | null = null;
  let running: Promise<ClaudeAuth> | null = null;
  return (): Promise<ClaudeAuth> => {
    if (cached && Date.now() - cached.at < (options.ttlMs ?? 60_000))
      return Promise.resolve(cached.auth);
    running ??= new Promise<ClaudeAuth>((resolve) => {
      const env = options.env ?? process.env;
      const shell = options.shell ?? defaultShell(env);
      let out = "";
      let settled = false;
      const marker = "__lanework_claude_auth__";
      const child = spawn(
        shell.file,
        [
          ...shell.args,
          "-i",
          "-c",
          `printf '%s\\n' '${marker}'; claude auth status --json`,
        ],
        {
          cwd: homedir(),
          env: shellEnv(env),
          stdio: ["ignore", "pipe", "ignore"],
          detached: process.platform !== "win32",
        },
      );
      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          resolve(
            claudeAuthOf(
              JSON.parse(
                out.slice(out.lastIndexOf(marker) + marker.length).trim(),
              ),
            ),
          );
        } catch {
          resolve(claudeAuthOf(null));
        }
        out = "";
      };
      const timer = setTimeout(() => {
        kill();
        settle();
      }, options.timeoutMs ?? 5000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.length > 64 * 1024) {
          out = "";
          kill();
          settle();
        }
      });
      child.once("error", settle);
      child.once("close", settle);
    })
      .then((auth) => {
        cached = { at: Date.now(), auth };
        return auth;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}

/**
 * The one `claude auth status` probe of this process: the usage footer and
 * Settings › Harness share its cache rather than each starting a shell.
 */
export const claudeAuth = createClaudeAuthProbe();
