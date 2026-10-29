// Whether Claude Code, Codex and OpenCode are signed in to the cloud
// `lanework` MCP server, and a way to sign them in from Settings → Agents.
//
// NOTE: Each CLI is asked (`codex mcp list --json`, `claude mcp get
// lanework`, `opencode mcp list`); their token stores are never read. Claude Code keeps its tokens
// in the Keychain under its own item (reading it would prompt the user), and
// either CLI may move them in any release: the CLI is the one that knows.
//
// NOTE: The CLIs run through the user's login shell (`runInLoginShell`), like
// the harness probe: an app opened from the Dock has launchd's PATH, not the
// profile's.
//
// Electron-free, so the parsers can be driven by a spec.
import { MCP_HOST } from "../../../shared/agent-notes";
import type { LaneworkMcpAgent, LaneworkMcpAuth } from "../../../shared/auth";
import { afterMarker, runInLoginShell } from "../harness/shell";
import { MCP_NAME } from "./mcp-entry";

const COMMAND: Record<LaneworkMcpAgent, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
};

/**
 * Parse `opencode mcp list`: our server's line (FE-104).
 *
 * OpenCode prints text only, one `<mark> <name>  <status>` line per server:
 * `connected`, `needs authentication`, `failed: <error>`, or another state
 * (`pending`, `disabled`), which is "unknown", never a guess.
 */
function parseOpencodeAuth(output: string): LaneworkMcpAuth {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\S+\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== MCP_NAME) continue;
    const status = match[2] ?? "";
    if (/^needs auth/i.test(status)) return "needs-login";
    if (/^failed\b/i.test(status)) return "failed";
    if (/^connected$/i.test(status)) return "signed-in";
    return "unknown";
  }
  return "unknown";
}

/** Parse `codex mcp list --json`: the `auth_status` of our server. */
function parseCodexAuth(output: string): LaneworkMcpAuth {
  let list: unknown;
  try {
    list = JSON.parse(output.trim());
  } catch {
    return "unknown";
  }
  if (!Array.isArray(list)) return "unknown";
  const entry: unknown = list.find(
    (server: unknown) =>
      !!server &&
      typeof server === "object" &&
      (server as { name?: unknown }).name === MCP_NAME,
  );
  if (!entry || typeof entry !== "object") return "unknown";
  const status = (entry as { auth_status?: unknown }).auth_status;
  // `o_auth` holds a token; `bearer_token` is a header the user set by hand.
  if (status === "o_auth" || status === "bearer_token") return "signed-in";
  if (status === "not_logged_in") return "needs-login";
  return "unknown";
}

/**
 * Parse `claude mcp get lanework`: its `Status:` line.
 *
 * The line reads `✔ Connected`, `! Needs authentication` or
 * `✗ Failed to connect`. Claude Code prints text only, so any other line is
 * "unknown", never a guess.
 */
function parseClaudeAuth(output: string): LaneworkMcpAuth {
  const line = /^\s*Status:\s*(.+)$/m.exec(output)?.[1] ?? "";
  if (/needs authentication/i.test(line)) return "needs-login";
  if (/failed to connect/i.test(line)) return "failed";
  if (/\bconnected\b/i.test(line)) return "signed-in";
  return "unknown";
}

const mark = (agent: LaneworkMcpAgent, part: string) =>
  `__lanework_mcp_auth_${agent}_${part}__`;

/**
 * The shell command that runs the CLI with `args` under a pseudo-terminal.
 *
 * Its output is piped back out.
 *
 * NOTE: Claude Code's `mcp login` gives up the moment its stdin is not a TTY
 * ("stdin isn't a terminal") instead of waiting for the browser's callback,
 * and the shell's stdin is /dev/null. `script` hands it a pty for stdin.
 * stdout stays a pipe, so it never opens its paste-the-URL prompt and never
 * reads the EOF `script` writes into the pty. A stdout that is not a TTY
 * also stops it opening the browser, so `loginLaneworkMcp` opens the URL it
 * prints ({@link authorizeUrl}). `$LANEWORK_MCP_CLI` is the
 * CLI's path: an alias from the profile does not reach `script`'s `sh`.
 */
function underTty(args: string): string {
  const inner = `"$LANEWORK_MCP_CLI" ${args} 2>&1 | cat`;
  return process.platform === "darwin"
    ? `script -q /dev/null sh -c '${inner}' </dev/null`
    : `script -qec '${inner}' /dev/null </dev/null`;
}

/**
 * Run the agent's CLI with `args` in the login shell.
 *
 * @param tty Run it under a pseudo-terminal ({@link underTty}).
 * @param onOutput What the CLI printed so far, each time more arrives.
 * @returns The CLI's own output, after the profile's; null when the CLI is
 *   not on the shell's PATH; undefined when the shell never reached it.
 */
async function inShell(
  agent: LaneworkMcpAgent,
  args: string,
  timeoutMs: number,
  tty = false,
  onOutput?: (output: string) => void,
): Promise<string | null | undefined> {
  const command = COMMAND[agent];
  const [missing, start] = [mark(agent, "missing"), mark(agent, "start")];
  const line = (marker: string) => `printf '\\n%s\\n' '${marker}'`;
  const run = tty
    ? [
        `LANEWORK_MCP_CLI=$(command -v ${command})`,
        `case "$LANEWORK_MCP_CLI" in /*) ;; *) LANEWORK_MCP_CLI=${command} ;; esac`,
        "export LANEWORK_MCP_CLI",
        underTty(args),
      ].join("; ")
    : `${command} ${args} </dev/null 2>&1`;
  const script = [
    `if ! command -v ${command} >/dev/null 2>&1; then ${line(missing)}; exit 0; fi`,
    line(start),
    run,
  ].join("; ");
  let seen = "";
  const { stdout } = await runInLoginShell(script, {
    timeoutMs,
    onStdout: onOutput
      ? (chunk) => {
          seen += chunk;
          const own = afterMarker(seen, start);
          if (own !== null) onOutput(own);
        }
      : undefined,
  });
  if (afterMarker(stdout, missing) !== null) return null;
  return afterMarker(stdout, start) ?? undefined;
}

/**
 * Ask `agent` whether it holds a credential for our server.
 *
 * @returns `no-cli` when the CLI is not on the shell's PATH; `unknown` when
 *   it did not answer, or on Windows.
 */
export async function laneworkMcpAuth(
  agent: LaneworkMcpAgent,
): Promise<LaneworkMcpAuth> {
  if (process.platform === "win32") return "unknown";
  const output = await inShell(
    agent,
    agent === "codex"
      ? "mcp list --json"
      : agent === "opencode"
        ? "mcp list"
        : `mcp get ${MCP_NAME}`,
    15_000,
  );
  if (output === null) return "no-cli";
  if (output === undefined) return "unknown";
  return agent === "codex"
    ? parseCodexAuth(output)
    : agent === "opencode"
      ? parseOpencodeAuth(output)
      : parseClaudeAuth(output);
}

/**
 * The sign-in page `mcp login` printed, once a character that ends a URL
 * follows it (a chunk can stop mid-URL).
 *
 * Only an https URL on our MCP server's host: whatever else the profile or
 * the CLI prints is never handed to the browser.
 */
export function authorizeUrl(output: string): string | null {
  for (const [found] of output.matchAll(
    /https:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+(?=[^\w\-.~:/?#[\]@!$&'()*+,;=%])/g,
  )) {
    try {
      const url = new URL(found);
      if (url.protocol === "https:" && url.hostname === MCP_HOST)
        return url.href;
    } catch {
      // Not a URL; keep looking.
    }
  }
  return null;
}

/** One login per agent at a time; a second click waits on the first. */
const pending = new Map<LaneworkMcpAgent, Promise<LaneworkMcpAuth>>();
/** The sign-in page of the login still running, opened again on a second click. */
const pages = new Map<LaneworkMcpAgent, string>();

/**
 * Run `<cli> mcp login lanework` (`opencode mcp auth lanework`).
 *
 * The CLI waits for the OAuth callback; Codex and OpenCode open the browser
 * themselves.
 * Claude Code runs on a pseudo-terminal ({@link underTty}) and does not, so
 * `open` gets the page it prints. It has five minutes to finish, then the
 * shell is killed. Either way the answer is what the CLI reports after.
 *
 * @param open Opens a URL in the user's browser.
 */
export function loginLaneworkMcp(
  agent: LaneworkMcpAgent,
  open: (url: string) => void,
): Promise<LaneworkMcpAuth> {
  const running = pending.get(agent);
  if (running) {
    const page = pages.get(agent);
    if (page) open(page);
    return running;
  }
  const login = (async () => {
    if (process.platform === "win32") return "unknown" as const;
    const output = await inShell(
      agent,
      agent === "opencode" ? `mcp auth ${MCP_NAME}` : `mcp login ${MCP_NAME}`,
      300_000,
      agent === "claude-code",
      agent === "claude-code"
        ? (output) => {
            if (pages.has(agent)) return;
            const page = authorizeUrl(output);
            if (!page) return;
            pages.set(agent, page);
            open(page);
          }
        : undefined,
    );
    if (output === null) return "no-cli" as const;
    return laneworkMcpAuth(agent);
  })().finally(() => {
    pending.delete(agent);
    pages.delete(agent);
  });
  pending.set(agent, login);
  return login;
}
