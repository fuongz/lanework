// What the user chose in Settings → Agents for the `lanework` MCP entries
// (FE-119/D1): `<app home>/agent-setup.json`.
//
// NOTE: Only explicit choices are stored. An agent with none follows
// `TOOLSET_DEFAULTS`, so changing a default reaches every install that never
// chose.
//
// Electron-free, so a spec can drive it against a temp `LANEWORK_HOME`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LaneworkMcpAgent,
  LaneworkMcpToolset,
} from "../../../shared/auth";
import { appHomeDir } from "../paths";

/**
 * The toolset each agent gets until the user picks one.
 *
 * - Claude Code defers loading tool schemas, so the full set costs it little.
 * - Codex loads every tool into every session: the worker set (BE-24) is
 *   about a quarter of the bytes.
 * - OpenCode is always `full`; see {@link WORKER_AGENTS}.
 */
export const TOOLSET_DEFAULTS: Record<LaneworkMcpAgent, LaneworkMcpToolset> = {
  "claude-code": "full",
  codex: "worker",
  opencode: "full",
};

/**
 * The agents whose CLI signs in to `/v1?toolset=worker`.
 *
 * NOTE: Not OpenCode (2.2). Its OAuth provider uses the server URL itself as
 * the RFC 8707 `resource` whenever the metadata names the same origin and
 * path, so it sends `https://mcp.lanework.dev/v1?toolset=worker`, and the
 * authorization server answers `invalid_target` ("requested resource … is not
 * configured"). Codex and Claude Code take the resource from the server's
 * metadata (the bare `/v1`) and sign in.
 */
export const WORKER_AGENTS: readonly LaneworkMcpAgent[] = [
  "claude-code",
  "codex",
];

type Prefs = {
  mcpToolset?: Partial<Record<LaneworkMcpAgent, LaneworkMcpToolset>>;
};

const prefsPath = () => join(appHomeDir(), "agent-setup.json");

const isToolset = (value: unknown): value is LaneworkMcpToolset =>
  value === "full" || value === "worker";

/** The file's choices; a missing or broken file is no choices. */
async function readPrefs(): Promise<Prefs> {
  const raw: unknown = await readFile(prefsPath(), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => ({}));
  if (!raw || typeof raw !== "object") return {};
  const stored = (raw as { mcpToolset?: unknown }).mcpToolset;
  const mcpToolset: Prefs["mcpToolset"] = {};
  if (stored && typeof stored === "object")
    for (const [agent, value] of Object.entries(stored))
      if (agent in TOOLSET_DEFAULTS && isToolset(value))
        mcpToolset[agent as LaneworkMcpAgent] = value;
  return { mcpToolset };
}

/** The toolset `agent`'s cloud entry is written with. */
export async function toolsetFor(
  agent: LaneworkMcpAgent,
): Promise<LaneworkMcpToolset> {
  if (!WORKER_AGENTS.includes(agent)) return "full";
  return (await readPrefs()).mcpToolset?.[agent] ?? TOOLSET_DEFAULTS[agent];
}

/** Every agent's toolset, as {@link toolsetFor} answers. */
export async function toolsets(): Promise<
  Record<LaneworkMcpAgent, LaneworkMcpToolset>
> {
  const [claude, codex, opencode] = await Promise.all([
    toolsetFor("claude-code"),
    toolsetFor("codex"),
    toolsetFor("opencode"),
  ]);
  return { "claude-code": claude, codex, opencode };
}

/**
 * Remember `toolset` for `agent`.
 *
 * @throws For `worker` on an agent outside {@link WORKER_AGENTS}.
 */
export async function setToolsetPref(
  agent: LaneworkMcpAgent,
  toolset: LaneworkMcpToolset,
): Promise<void> {
  if (toolset === "worker" && !WORKER_AGENTS.includes(agent))
    throw new Error(
      "OpenCode cannot sign in to the worker toolset yet. It keeps every tool.",
    );
  const prefs = await readPrefs();
  const next: Prefs = {
    ...prefs,
    mcpToolset: { ...prefs.mcpToolset, [agent]: toolset },
  };
  const path = prefsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
