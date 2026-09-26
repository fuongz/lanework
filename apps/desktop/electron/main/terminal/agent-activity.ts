// Which agent conversations are being written right now (FE-25/D3): the
// transcripts a project's folder has, watched rather than polled.
//
// ⚠️ Nothing here imports Electron, so a spec can drive it under plain Node
// against a fake home folder.
import { type FSWatcher, watch } from "node:fs";
import { basename, join } from "node:path";
import { isAgentSessionId, type TerminalAgent } from "../../../shared/terminal";
import {
  claudeProjectDir,
  codexRolloutOf,
  transcriptWorking,
} from "./agent-sessions";

/**
 * How long after a write its transcript is read for the turn's state.
 *
 * ⚠️ A read at the END of the window, of the file as it is THEN — not one
 * per write, and never a write skipped. A turn closes with its last write,
 * and a throttle that dropped that one would leave a row spinning for good.
 */
const SETTLE_MS = 400;

const TRAILING_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Watch `folder`'s Claude and Codex transcripts under `home`, and call
 * `onActivity` when one is written. Returns the stop.
 *
 * ⚠️ The id comes from the file NAME — `<id>.jsonl` for Claude, a rollout
 * ending in its id for Codex — so a write costs no read of the listing.
 * Codex keeps every folder's rollouts in one tree, so a rollout seen for the
 * first time is opened once to learn whose it is, and the answer is kept.
 *
 * ⚠️ A folder that does not exist yet is simply not watched. The rail lists
 * again on focus, which starts the watch once the CLI has made it.
 */
export function watchAgentActivity(
  home: string,
  folder: string,
  onActivity: (agent: TerminalAgent, id: string, working: boolean) => void,
): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, NodeJS.Timeout>();
  const said = new Map<string, boolean>();
  let stopped = false;
  const report = (agent: TerminalAgent, id: string, file: string) => {
    const key = `${agent}:${id}`;
    if (pending.has(key)) return;
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void transcriptWorking(file, agent as "claude" | "codex").then(
          (working) => {
            // Only a CHANGE is news: a row already spinning is not told again
            // on every write of the turn it is spinning for.
            if (stopped || said.get(key) === working) return;
            said.set(key, working);
            onActivity(agent, id, working);
          },
        );
      }, SETTLE_MS),
    );
  };

  const claudeDir = join(home, ".claude", "projects", claudeProjectDir(folder));
  try {
    watchers.push(
      watch(claudeDir, (_event, name) => {
        const id = name ? basename(String(name)).replace(/\.jsonl$/, "") : "";
        if (name && String(name).endsWith(".jsonl") && isAgentSessionId(id))
          report("claude", id, join(claudeDir, `${id}.jsonl`));
      }),
    );
  } catch {
    // No Claude conversations for this folder yet.
  }

  const codexRoot = join(home, ".codex", "sessions");
  const whose = new Map<string, Promise<string | false | null>>();
  try {
    watchers.push(
      watch(codexRoot, { recursive: true }, (_event, name) => {
        const match = name ? TRAILING_ID.exec(String(name)) : null;
        if (!match?.[1] || !basename(String(name)).startsWith("rollout-"))
          return;
        const file = join(codexRoot, String(name));
        let known = whose.get(file);
        if (!known) {
          known = codexRolloutOf(file, folder);
          whose.set(file, known);
        }
        void known.then((id) => {
          if (id) report("codex", id, file);
          // Not readable yet: asked again on its next write. Another
          // folder's (`false`) stays cached and is never opened again.
          else if (id === null) whose.delete(file);
        });
      }),
    );
  } catch {
    // No Codex sessions on this machine.
  }

  for (const watcher of watchers) watcher.on("error", () => watcher.close());
  return () => {
    stopped = true;
    for (const timer of pending.values()) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
