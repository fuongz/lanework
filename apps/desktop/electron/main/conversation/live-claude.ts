// Which live `claude` process is on a conversation, from the file the CLI
// keeps for itself at `~/.claude/sessions/<pid>.json` (FE-31 reads the same).
//
// The single-writer rule's fallback (FE-62/D3): it sees a Claude on the
// conversation wherever it runs — a Lanework tab, or a terminal app.
//
// ⚠️ Not a documented interface: missing, unreadable or of another shape, a
// file says nothing, and a pid that is not alive any more is no writer.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAgentSessionId } from "../../../shared/terminal";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pids of live Claude processes on `conversation`, minus `ours`. */
export async function claudePidsOn(
  home: string,
  conversation: string,
  ours: ReadonlySet<number>,
): Promise<number[]> {
  if (!isAgentSessionId(conversation)) return [];
  const dir = join(home, ".claude", "sessions");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: number[] = [];
  for (const name of names) {
    const pid = Number(/^(\d+)\.json$/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || ours.has(pid)) continue;
    try {
      const value = JSON.parse(await readFile(join(dir, name), "utf8")) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      if (value.pid !== pid || value.sessionId !== conversation) continue;
      if (alive(pid)) out.push(pid);
    } catch {
      // Being written, or not ours.
    }
  }
  return out;
}
