// Which conversation each running agent tab is on NOW (FE-31) — not the one
// it was started with.
//
// ⚠️ A tab's `resume` is set at spawn, and the CLI can leave it behind: a new
// Codex tab has none (Codex takes no `--session-id`), and Claude's `/clear`
// or `/resume` moves to another conversation inside the same process. Either
// way the rail showed the tab AND the transcript it is really writing as two
// rows for one agent, and a click on the second started another agent on it.
//
// ⚠️ Nothing here imports Electron, so a spec can drive it under plain Node
// against a fake home folder.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isAgentSessionId,
  type TerminalSession,
} from "../../../shared/terminal";
import { codexStarts } from "./agent-sessions";

/** A tab whose conversation is not the one it says: its id, and the right one. */
interface AgentBinding {
  id: string;
  resume: string;
}

/**
 * How far before its tab a CLI's start may be stamped and still be that
 * tab's: clocks are read in two processes, a millisecond apart or so.
 */
const SLACK_MS = 2_000;

/**
 * The conversation the Claude CLI running as `pid` is on, from the file it
 * keeps for itself at `~/.claude/sessions/<pid>.json`.
 *
 * ⚠️ Not a documented interface — a better answer when it is there, never a
 * requirement: missing, unreadable, another shape, or written by an EARLIER
 * process that had the same pid, it is null and the tab keeps what it had.
 */
async function claudeConversation(
  home: string,
  pid: number,
  createdAt: number,
): Promise<string | null> {
  try {
    const file = join(home, ".claude", "sessions", `${pid}.json`);
    const value = JSON.parse(await readFile(file, "utf8")) as {
      pid?: unknown;
      sessionId?: unknown;
      startedAt?: unknown;
    };
    if (value.pid !== pid || !isAgentSessionId(value.sessionId)) return null;
    // The pid's previous owner, before this tab's CLI started.
    if (typeof value.startedAt !== "number") return null;
    if (value.startedAt < createdAt - SLACK_MS) return null;
    return value.sessionId;
  } catch {
    return null;
  }
}

/**
 * The tabs of one folder whose conversation moved, and where to.
 *
 * - Claude: the CLI's own pid file. `exec` makes the pty's pid the CLI's.
 * - Codex: a tab with NO conversation yet takes the rollout of this folder
 *   whose start is closest after the tab's, among those no other tab is on
 *   (FE-31/D3). One Codex can only start after its tab, so nearest-first
 *   pairs two new tabs with their own two rollouts.
 */
export async function agentBindings(
  home: string,
  folder: string,
  terminals: readonly TerminalSession[],
): Promise<AgentBinding[]> {
  const live = terminals.filter(
    (entry) => entry.kind !== "shell" && !entry.exit,
  );
  const out: AgentBinding[] = [];
  const now = new Map(terminals.map((entry) => [entry.id, entry.resume]));

  for (const entry of live) {
    if (entry.kind !== "claude") continue;
    const current = await claudeConversation(home, entry.pid, entry.createdAt);
    if (current && current !== entry.resume) {
      out.push({ id: entry.id, resume: current });
      now.set(entry.id, current);
    }
  }

  const waiting = live.filter(
    (entry) => entry.kind === "codex" && entry.resume === null,
  );
  if (waiting.length === 0) return out;
  const taken = new Set([...now.values()].filter((id) => id !== null));
  const since = Math.min(...waiting.map((entry) => entry.createdAt)) - SLACK_MS;
  const starts = (await codexStarts(home, folder, since)).filter(
    (start) => !taken.has(start.id),
  );
  const pairs = waiting
    .flatMap((entry) =>
      starts
        .filter((start) => start.startedAt >= entry.createdAt - SLACK_MS)
        .map((start) => ({
          entry,
          start,
          gap: start.startedAt - entry.createdAt,
        })),
    )
    .sort((a, b) => a.gap - b.gap);
  const paired = new Set<string>();
  for (const { entry, start } of pairs) {
    if (paired.has(entry.id) || taken.has(start.id)) continue;
    paired.add(entry.id);
    taken.add(start.id);
    out.push({ id: entry.id, resume: start.id });
  }
  return out;
}
