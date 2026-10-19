import type { MachineOwner } from "@lanework/protocol";

/**
 * Who is asking, and what the control plane last said about them.
 *
 * A desktop install is a MACHINE, never a human session: the sign-in flow sends
 * a human to their own browser and this app receives a machine credential once
 * that human approves. No session cookie ever reaches this process, which is
 * why "human" is not a principal this app can hold — see `policy.ts`.
 */
/**
 * Who the account belongs to, as much of it as a machine credential may read.
 *
 * The control plane returns this account display from `GET /v1/machines/me`.
 * Account editing stays behind a browser session this app never holds. Workspace
 * discovery uses the separate machine-authenticated sync surface. Fields are
 * nullable because a client must be able to say "we do not know" rather than
 * render `undefined`.
 */
export type AccountOwner = MachineOwner;

export type Principal =
  | { kind: "anonymous" }
  | {
      kind: "machine";
      machineId: string;
      userId: string | null;
      name: string;
      owner: AccountOwner | null;
    }
  /**
   * We hold a credential the control plane no longer accepts. Distinct from
   * `anonymous` because there is still something on this disk to clean up, and
   * because "your access was revoked" and "you are not signed in" are different
   * things to tell someone.
   */
  | { kind: "revoked"; machineId: string; name: string }
  /**
   * FE-52: nobody signed in, and the person chose "Skip for now". Boards live
   * in the local SQLite store and nothing calls the control plane. Signing in
   * later turns this into `machine`; the local boards stay (FE-52/D6a).
   */
  | { kind: "local" };

/** What the control plane last said about our credential. */
export type Verdict = "ok" | "revoked" | "unreachable";

/**
 * Everything the renderer is allowed to know. There is deliberately no field
 * for the secret: this object crosses into a web origin, and a token in the
 * renderer is readable by anything that achieves script execution there.
 */
export interface RedactedSession {
  principal: Principal;
  /** Control-plane origin in force. Always set — see `resolveApi`. */
  apiUrl: string;
  /** `null` means nobody has asked yet — not the same as "unreachable". */
  verdict: Verdict | null;
  checkedAt: string | null;
}

export type SignInMode = "loopback" | "device";

/** Progress a sign-in reports before it finishes, so a UI can show the URL/code. */
export type SignInProgress =
  | { mode: "loopback"; authorizeUrl: string; port: number }
  | {
      mode: "device";
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      interval: number;
    };

export const authChannels = {
  session: "auth:session",
  signIn: "auth:sign-in",
  signOut: "auth:sign-out",
  cancel: "auth:cancel",
  changed: "auth:changed",
  progress: "auth:progress",
  /** FE-52: "Skip for now" — run without an account, on the local store. */
  enterLocal: "auth:enter-local",
} as const;

export interface DesktopAuthApi {
  getSession: () => Promise<RedactedSession>;
  signIn: (mode?: SignInMode) => Promise<RedactedSession>;
  signOut: () => Promise<RedactedSession>;
  /** Abort an in-flight sign-in. Resolves whether or not one was running. */
  cancelSignIn: () => Promise<void>;
  /**
   * FE-52/D5: "Skip for now". Remembers the choice and answers a session whose
   * principal is `local`. A no-op that answers the current session when a
   * machine credential is already held.
   */
  enterLocalMode: () => Promise<RedactedSession>;
  onSessionChange: (listener: (session: RedactedSession) => void) => () => void;
  onSignInProgress: (
    listener: (progress: SignInProgress) => void,
  ) => () => void;
}

/**
 * FE-52/D8: the `lanework` MCP server entry in an agent's user config —
 * `~/.claude.json` for Claude Code, `config.toml` for Codex. `local` is the
 * offline server over stdio (the app's own shim), `cloud` is
 * `https://mcp.lanework.dev/v1` over HTTP.
 */
export type LaneworkMcpMode = "local" | "cloud";
export type LaneworkMcpAgent = "claude-code" | "codex";

export interface LaneworkMcpEntry {
  /** A `lanework` entry is in this agent's config. */
  installed: boolean;
  /** …and it points at us — our shim or our cloud host — so the app may switch it. */
  ours: boolean;
  /** Where it points, when it is ours. */
  mode: LaneworkMcpMode | null;
  transport: "stdio" | "http" | null;
  configPath: string;
  /** The file exists but is not something the app will rewrite. */
  unreadable: boolean;
}

/**
 * Whether the agent's CLI holds a credential for the cloud server, as the
 * CLI itself reports it. `failed`: it has one but could not reach the
 * server with it; `no-cli`: not on the shell's PATH; `unknown`: it did not
 * answer, or answered in a shape the app cannot read.
 */
export type LaneworkMcpAuth =
  | "signed-in"
  | "needs-login"
  | "failed"
  | "no-cli"
  | "unknown";

export interface LaneworkMcpStatus {
  /** What the current session wants: `local` in local mode, `cloud` signed in. */
  want: LaneworkMcpMode | null;
  /** The stdio entry's command. */
  shimPath: string;
  claude: LaneworkMcpEntry;
  codex: LaneworkMcpEntry;
}

export const laneworkMcpChannels = {
  status: "lanework-mcp:status",
  /** Write the entry for one agent, pointed at what the session wants. */
  install: "lanework-mcp:install",
  remove: "lanework-mcp:remove",
  /** Ask one agent's CLI whether it is signed in to the cloud server. */
  auth: "lanework-mcp:auth",
  /** Run `<cli> mcp login lanework`, then ask again. */
  login: "lanework-mcp:login",
} as const;

export interface DesktopLaneworkMcpApi {
  status: () => Promise<LaneworkMcpStatus>;
  install: (agent: LaneworkMcpAgent) => Promise<LaneworkMcpStatus>;
  remove: (agent: LaneworkMcpAgent) => Promise<LaneworkMcpStatus>;
  auth: (agent: LaneworkMcpAgent) => Promise<LaneworkMcpAuth>;
  login: (agent: LaneworkMcpAgent) => Promise<LaneworkMcpAuth>;
}

export const anonymous: Principal = { kind: "anonymous" };

/** FE-52: the session "Skip for now" reports — no credential, the local board. */
export function localSession(apiUrl: string): RedactedSession {
  return {
    principal: { kind: "local" },
    apiUrl,
    verdict: null,
    checkedAt: null,
  };
}

/** The session an unconfigured or signed-out install reports. */
export function anonymousSession(apiUrl: string): RedactedSession {
  return { principal: anonymous, apiUrl, verdict: null, checkedAt: null };
}
