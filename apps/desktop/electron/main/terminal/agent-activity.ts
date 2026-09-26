// Which agent conversations are being written right now (FE-25/D3): the
// transcripts a project's folder has, watched rather than polled.
//
// ⚠️ Nothing here imports Electron, so a spec can drive it under plain Node
// against a fake home folder.
import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentCard,
  isAgentSessionId,
  type TerminalAgent,
} from "../../../shared/terminal";
import {
  claudeProjectDir,
  codexRolloutOf,
  lastCardIn,
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
  onActivity: (
    agent: TerminalAgent,
    id: string,
    working: boolean,
    card: AgentCard | null,
  ) => void,
): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, NodeJS.Timeout>();
  const said = new Map<string, string>();
  /**
   * The card each conversation last named, and how far its transcript has
   * been read for one (FE-27). Only the bytes written since are read again;
   * the first read of a conversation goes back `CARD_SCAN`.
   */
  const cards = new Map<string, { card: AgentCard | null; end: number }>();
  const cardOf = async (key: string, file: string) => {
    const size = (await stat(file)).size;
    const known = cards.get(key);
    // Shorter than what was read: rewritten, so read it as new.
    const from = known && known.end <= size ? known.end : 0;
    const read = await lastCardIn(file, from, size, true);
    // ⚠️ The NEWEST card wins (FE-27/D5): an agent that moves on to another
    // card moves its mark with it; bytes naming none keep the one it had.
    const next = { card: read.card ?? known?.card ?? null, end: read.end };
    cards.set(key, next);
    return next.card;
  };
  let stopped = false;
  const report = (agent: TerminalAgent, id: string, file: string) => {
    const key = `${agent}:${id}`;
    if (pending.has(key)) return;
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void (async () => {
          const working = await transcriptWorking(
            file,
            agent as "claude" | "codex",
          );
          // Looked for only while working: an idle agent is on no card.
          const card = working
            ? await cardOf(key, file).catch(() => null)
            : null;
          // Only a CHANGE is news: a row already spinning is not told again
          // on every write of the turn it is spinning for.
          const news = `${working}:${card?.boardId}:${card?.card}`;
          if (stopped || said.get(key) === news) return;
          said.set(key, news);
          onActivity(agent, id, working, card);
        })();
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
