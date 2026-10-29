import { useEffect } from "react";
import { create } from "zustand";
import type {
  LaneworkMcpAgent,
  LaneworkMcpAuth,
  LaneworkMcpEntry,
  LaneworkMcpStatus,
} from "../../shared/auth";
import { useSession } from "./session";

const MCP_AGENTS = [
  "claude-code",
  "codex",
  "opencode",
] as const satisfies readonly LaneworkMcpAgent[];

/** The command each agent's CLI goes by on the PATH. */
export const MCP_CLI: Record<LaneworkMcpAgent, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
};

/**
 * What signs an agent's CLI in to the `lanework` server from a terminal.
 *
 * NOTE: OpenCode names it `mcp auth`, not `mcp login`.
 */
export const MCP_LOGIN_COMMAND: Record<LaneworkMcpAgent, string> = {
  "claude-code": "claude mcp login lanework",
  codex: "codex mcp login lanework",
  opencode: "opencode mcp auth lanework",
};

/** The `lanework` entry in `agent`'s own config, as `status` reads it. */
export function mcpEntry(
  status: LaneworkMcpStatus | null | undefined,
  agent: LaneworkMcpAgent,
): LaneworkMcpEntry | undefined {
  if (!status) return undefined;
  switch (agent) {
    case "claude-code":
      return status.claude;
    case "codex":
      return status.codex;
    case "opencode":
      return status.opencode;
  }
}

/** What a row shows: the CLI's answer, or that one is on its way. */
export type McpAuthView = LaneworkMcpAuth | "checking" | "login";

/**
 * Whether an answer needs the user.
 *
 * The island comes up for these.
 */
export const needsAttention = (auth: LaneworkMcpAuth | undefined): boolean =>
  auth === "needs-login" || auth === "failed";

/** Agents whose `lanework` entry is ours and points at the cloud. */
export function cloudAgents(
  status: LaneworkMcpStatus | null,
): LaneworkMcpAgent[] {
  return MCP_AGENTS.filter((agent) => {
    const entry = mcpEntry(status, agent);
    return !!entry?.ours && entry.mode === "cloud";
  });
}

/**
 * Whether Claude Code, Codex and OpenCode are signed in to the cloud Lanework
 * MCP.
 *
 * Read by Settings › Agents and the sign-in island.
 *
 * NOTE: `settled` is the last answer and survives a re-check, so a check that
 * runs while the island is up does not make it blink. `view` is what a row
 * shows right now, "checking" included.
 */
interface McpAuthState {
  status: LaneworkMcpStatus | null;
  view: Partial<Record<LaneworkMcpAgent, McpAuthView>>;
  settled: Partial<Record<LaneworkMcpAgent, LaneworkMcpAuth>>;
  /** When a login from this window last finished signed in (epoch ms). */
  signedInAt: Partial<Record<LaneworkMcpAgent, number>>;
  /**
   * An answer the user waved away.
   *
   * The island stays off until the answer changes.
   */
  dismissed: Partial<Record<LaneworkMcpAgent, LaneworkMcpAuth>>;
  loadStatus: () => Promise<void>;
  setStatus: (status: LaneworkMcpStatus) => void;
  check: (agent: LaneworkMcpAgent) => Promise<void>;
  login: (agent: LaneworkMcpAgent) => Promise<LaneworkMcpAuth>;
  dismiss: (agent: LaneworkMcpAgent) => void;
}

const surface = () => window.desktop?.laneworkMcp;

export const useMcpAuth = create<McpAuthState>((set, get) => {
  const answer = (agent: LaneworkMcpAgent, auth: LaneworkMcpAuth) =>
    set((state) => ({
      view: { ...state.view, [agent]: auth },
      settled: { ...state.settled, [agent]: auth },
    }));
  return {
    status: null,
    view: {},
    settled: {},
    signedInAt: {},
    dismissed: {},
    loadStatus: async () => {
      const api = surface();
      if (!api) return;
      const status = await api.status().catch(() => null);
      if (status) get().setStatus(status);
    },
    setStatus: (status) => {
      // An agent that is no longer on the cloud has nothing to sign in to.
      const keep = new Set(cloudAgents(status));
      const only = <T>(record: Partial<Record<LaneworkMcpAgent, T>>) =>
        Object.fromEntries(
          Object.entries(record).filter(([agent]) =>
            keep.has(agent as LaneworkMcpAgent),
          ),
        ) as Partial<Record<LaneworkMcpAgent, T>>;
      set((state) => ({
        status,
        view: only(state.view),
        settled: only(state.settled),
      }));
    },
    check: async (agent) => {
      const api = surface();
      const now = get().view[agent];
      if (!api || now === "checking" || now === "login") return;
      set((state) => ({ view: { ...state.view, [agent]: "checking" } }));
      answer(agent, await api.auth(agent).catch(() => "unknown" as const));
    },
    login: async (agent) => {
      const api = surface();
      if (!api) return "unknown";
      set((state) => ({ view: { ...state.view, [agent]: "login" } }));
      const auth = await api.login(agent).catch(() => "unknown" as const);
      answer(agent, auth);
      if (auth === "signed-in")
        set((state) => ({
          signedInAt: { ...state.signedInAt, [agent]: Date.now() },
        }));
      return auth;
    },
    dismiss: (agent) => {
      const auth = get().settled[agent];
      if (auth)
        set((state) => ({ dismissed: { ...state.dismissed, [agent]: auth } }));
    },
  };
});

/** How often the shell asks again while the app is open. */
const EVERY_MS = 10 * 60_000;
/**
 * The shortest gap between two checks on window focus.
 *
 * Coming back to the window asks again, but not more than once a minute.
 */
const FOCUS_GAP_MS = 60_000;

/**
 * Keep the answers fresh while the shell is mounted.
 *
 * Asks on launch, when the session or the entries change, every
 * {@link EVERY_MS}, and on focus. A token that expired, or a login finished
 * in a terminal, shows up without a visit to Settings.
 *
 * NOTE: Codex answers from the token it holds, without reaching the server.
 * A token the server revoked reads as signed in until Codex finds out.
 * Claude Code's check does reach the server.
 */
export function useMcpAuthWatch(): void {
  const kind = useSession((state) => state.session?.principal.kind);
  const loadStatus = useMcpAuth((state) => state.loadStatus);
  const check = useMcpAuth((state) => state.check);
  const cloudKey = useMcpAuth((state) => cloudAgents(state.status).join(","));

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the session changes
  useEffect(() => {
    void loadStatus();
  }, [kind, loadStatus]);

  useEffect(() => {
    if (!cloudKey) return;
    const agents = cloudKey.split(",") as LaneworkMcpAgent[];
    let last = 0;
    const all = () => {
      if (!navigator.onLine) return;
      last = Date.now();
      for (const agent of agents) void check(agent);
    };
    all();
    const timer = window.setInterval(all, EVERY_MS);
    const onFocus = () => {
      if (Date.now() - last >= FOCUS_GAP_MS) all();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", all);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", all);
    };
  }, [cloudKey, check]);
}
