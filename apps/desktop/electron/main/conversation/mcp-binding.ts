// Which Lanework board server one conversation's agent talks to (FE-121/D9).
//
// The agents' own config holds ONE `lanework` entry for the whole machine:
// the offline server over stdio in local mode, the cloud one over HTTP once
// signed in (`agent-setup/mcp-entry.ts`). Signed in, a LOCAL project's chat
// would reach the cloud, where its board does not exist. So that one
// conversation is started with the local server instead, through the CLI's
// own per-process flags. The machine-wide config is never touched.
//
// NOTE: Decided when the agent's process starts, never during a turn. A
// conversation whose project moves to the cloud picks the new server up the
// next time its process starts.
import { readText } from "../agent-home";
import { ensureMcpShim } from "../agent-setup/mcp-entry";
import { codexConfigPath } from "../handoff/codex";
import { inLocalMode, knownProject, LOCAL_RECORD } from "../projects/session";

/**
 * The local server's stdio shim, when `project`'s conversation must use it
 * instead of the configured one; null to keep the agent's own config.
 *
 * Null too when anything is unknown (a project that cannot be resolved, no
 * shim on this copy): the agent then starts exactly as before.
 */
export async function localMcpFor(project: string): Promise<string | null> {
  try {
    // Local mode: every conversation runs on the local board. Attached here
    // too, not left to the agents' own config: that config is the machine's,
    // and it may point at the cloud even so. The Preview never writes it
    // (another copy's entry stays), and a user may have changed it. Passing
    // the same server by flags when the config already names it is harmless.
    if (await inLocalMode()) return await ensureMcpShim();
    const { record } = await knownProject(project);
    if (record !== LOCAL_RECORD) return null;
    return await ensureMcpShim();
  } catch {
    return null;
  }
}

/** Whether Codex's config has a `[mcp_servers.lanework]` table of its own. */
export async function codexHasLaneworkTable(): Promise<boolean> {
  const text = await readText(codexConfigPath()).catch(() => null);
  return !!text && /^\s*\[mcp_servers\.lanework\]\s*$/m.test(text);
}

/** Whether Codex's config sets `developer_instructions` itself (BE-01). */
export async function codexHasDeveloperInstructions(): Promise<boolean> {
  const text = await readText(codexConfigPath()).catch(() => null);
  return !!text && /^\s*developer_instructions\s*=/m.test(text);
}

/**
 * The board of `project`, to tell its conversation's agent (its id is the
 * project's own), or null when the project cannot be resolved.
 */
export async function boardFor(
  project: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const { project: known } = await knownProject(project);
    // A project the service sent without an id has no board yet.
    return known.id ? { id: known.id, name: known.name } : null;
  } catch {
    return null;
  }
}
