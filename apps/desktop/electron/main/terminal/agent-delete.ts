// Delete one agent conversation's transcript for good (FE-57).
//
// NOTE: Apart from the archive, the one place Lanework writes into the CLIs'
// own folders. Every path is built here from ids main has already checked
// against this folder's listing; a page never names a file.
//
// Nothing here imports Electron: main passes the home, and a spec drives it
// against a fake one.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAgentSessionId, type TerminalAgent } from "../../../shared/terminal";
import {
  claudeProjectDir,
  codexRolloutOf,
  codexRollouts,
  lines,
} from "./agent-sessions";

/**
 * Delete a conversation main has checked is one of `folder`'s.
 *
 * - Claude: `<id>.jsonl` and its `<id>/` folder (sub-agents, tool results).
 * - Codex: the conversation's rollout, the rollouts it spawned, and its lines
 *   in `session_index.jsonl` (FE-57/D3).
 *
 * @throws when `id` is not a session id, or there is no file for it.
 */
export async function deleteAgentTranscript(
  home: string,
  folder: string,
  agent: TerminalAgent,
  id: string,
): Promise<void> {
  if (!isAgentSessionId(id))
    throw new Error("A valid conversation is required");
  if (agent === "claude") {
    const dir = join(home, ".claude", "projects", claudeProjectDir(folder));
    // The transcript first: once it is gone the rail no longer lists it,
    // whatever happens to the folder after.
    await rm(join(dir, `${id}.jsonl`));
    await rm(join(dir, id), { recursive: true, force: true });
    return;
  }
  const codex = join(home, ".codex");
  const doomed: string[] = [];
  for (const file of await codexRollouts(join(codex, "sessions"))) {
    const of = await codexRolloutOf(file, folder);
    if (of && (of.id === id || of.parent === id)) doomed.push(file);
  }
  if (doomed.length === 0)
    throw new Error("That conversation has no file here.");
  for (const file of doomed) await rm(file, { force: true });
  await dropCodexIndex(codex, id);
}

/**
 * Remove `id`'s lines from Codex's `session_index.jsonl`.
 *
 * The file is written whole to a temp file and moved over, so Codex never
 * reads half of it. Every other line is kept byte for byte, unparsed ones
 * included: the file is Codex's, not ours.
 *
 * @param codex The `.codex` folder.
 */
export async function dropCodexIndex(codex: string, id: string): Promise<void> {
  const file = join(codex, "session_index.jsonl");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  const kept = text.split("\n").filter((raw) => {
    const [line] = lines(`${raw}\n`, { head: true });
    return line?.id !== id;
  });
  if (kept.length === text.split("\n").length) return;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, kept.join("\n"));
  await rename(temp, file);
}
