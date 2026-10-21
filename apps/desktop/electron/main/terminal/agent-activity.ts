// Which agent conversations are being written right now (FE-25/D3): the
// transcripts a project's folder has, watched rather than polled.
//
// Nothing here imports Electron, so a spec can drive it under plain Node
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
  CLAUDE_SUBAGENT_FILE,
  claudeProjectDir,
  codexRolloutOf,
  lastCardIn,
  transcriptCompleted,
  transcriptWorking,
} from "./agent-sessions";

/**
 * How long after a write its transcript is read for the turn's state.
 *
 * NOTE: The read happens at the END of the window, of the file as it is
 * THEN. It is not one read per write, and no write is ever skipped. A turn
 * closes with its last write, and a throttle that dropped that one would
 * leave a row spinning for good.
 */
const SETTLE_MS = 400;

/** Codex rollouts of one folder watched file by file, at most. */
const FOLLOW_LIMIT = 16;

/** The session id a Codex rollout's file name ends in. */
const TRAILING_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** `<conversation>/subagents/agent-<id>.jsonl`, under Claude's folder. */
const CLAUDE_SUBAGENT_PATH = /^([^/\\]+)[/\\]subagents[/\\]([^/\\]+)$/;

/**
 * Watch `folder`'s Claude and Codex transcripts under `home`, and call
 * `onActivity` when one is written.
 *
 * The id comes from the file NAME (`<id>.jsonl` for Claude, a rollout ending
 * in its id for Codex), so a write costs no read of the listing. Codex keeps
 * every folder's rollouts in one tree, so a rollout seen for the first time
 * is opened once to learn whose it is, and the answer is kept.
 *
 * A folder that does not exist yet is not watched. The rail lists again on
 * focus, which starts the watch once the CLI has made it.
 *
 * @param onCompleted Called when a turn that was running ends complete.
 * @returns The function that stops every watch.
 */
export function watchAgentActivity(
  home: string,
  folder: string,
  onActivity: (
    agent: TerminalAgent,
    id: string,
    working: boolean,
    card: AgentCard | null,
    /** The sub-agent of `id` that was written, or null for `id` itself. */
    subagent: string | null,
  ) => void,
  /**
   * Called on every settled write, news or not (FE-31).
   *
   * A tab may have moved to the conversation being written even when its
   * turn's state did not change, or that conversation may only now have the
   * prompt that titles it.
   */
  onWrite?: (agent: TerminalAgent, id: string) => void,
  onCompleted?: (agent: TerminalAgent, id: string) => void,
): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, NodeJS.Timeout>();
  const said = new Map<string, string>();
  const running = new Set<string>();
  // The card each conversation last named, and how far its transcript has
  // been read for one (FE-27). Only the bytes written since are read again;
  // the first read of a conversation goes back `CARD_SCAN`.
  const cards = new Map<string, { card: AgentCard | null; end: number }>();
  const cardOf = async (key: string, file: string) => {
    const size = (await stat(file)).size;
    const known = cards.get(key);
    // Shorter than what was read: rewritten, so read it as new.
    const from = known && known.end <= size ? known.end : 0;
    const read = await lastCardIn(file, from, size, true);
    // The NEWEST card wins (FE-27/D5): an agent that moves on to another card
    // moves its mark with it; bytes naming none keep the one it had.
    const next = { card: read.card ?? known?.card ?? null, end: read.end };
    cards.set(key, next);
    return next.card;
  };
  let stopped = false;
  // With `subagent` set, it is that sub-agent of `id` that was written: its
  // own state, no card, and no `onWrite`, since a sub-agent is never the
  // conversation a tab is on.
  const report = (
    agent: TerminalAgent,
    id: string,
    file: string,
    subagent: string | null = null,
  ) => {
    const key = subagent ? `${agent}:${id}/${subagent}` : `${agent}:${id}`;
    if (pending.has(key)) return;
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        if (!stopped && !subagent) onWrite?.(agent, id);
        void (async () => {
          const working = await transcriptWorking(
            file,
            agent as "claude" | "codex",
            subagent !== null,
          );
          // Looked for only while working: an idle agent is on no card.
          const card =
            working && !subagent
              ? await cardOf(key, file).catch(() => null)
              : null;
          // Only a CHANGE is news: a row already spinning is not told again
          // on every write of the turn it is spinning for.
          // A sub-agent is the exception: every settled write of it is news,
          // at most one per `SETTLE_MS`. A viewer open on it reads it again on
          // each (FE-35/D11), and its working state alone stays `true` from
          // its first tool call to its report.
          const news = `${working}:${card?.boardId}:${card?.card}`;
          if (stopped) return;
          if (!subagent) {
            const wasRunning = running.delete(key);
            if (working) running.add(key);
            else if (
              wasRunning &&
              onCompleted &&
              (await transcriptCompleted(file, agent as "claude" | "codex"))
            ) {
              if (!stopped) onCompleted(agent, id);
            }
          }
          if (stopped) return;
          if (!subagent && said.get(key) === news) return;
          said.set(key, news);
          onActivity(agent, id, working, card, subagent);
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
  // NOTE: A sub-agent writes its OWN transcript, one folder down, while its
  // conversation's may sit still, as a background agent's does. It gets its
  // own recursive watch, so the conversations' watch above stays as it is.
  try {
    watchers.push(
      watch(claudeDir, { recursive: true }, (_event, name) => {
        const match = name ? CLAUDE_SUBAGENT_PATH.exec(String(name)) : null;
        const sub = match?.[2]
          ? CLAUDE_SUBAGENT_FILE.exec(match[2])?.[1]
          : null;
        if (match?.[1] && sub && isAgentSessionId(match[1]))
          report("claude", match[1], join(claudeDir, String(name)), sub);
      }),
    );
  } catch {
    // No Claude conversations for this folder yet.
  }

  const codexRoot = join(home, ".codex", "sessions");
  const whose = new Map<
    string,
    Promise<{ id: string; parent: string | null } | false | null>
  >();
  // This folder's rollouts, each watched on its own (FE-31).
  //
  // NOTE: The recursive watch alone is not enough on macOS. It reports a
  // rollout when it is created and when Codex closes it, and NOTHING of the
  // writes in between, because Codex keeps it open and appends. A turn would
  // then spin until the end, and a new Codex's prompt, written just after its
  // `session_meta`, would never be read. A watch on the file itself sees
  // every write. Capped: the oldest followed is let go first.
  const followed = new Map<string, FSWatcher>();
  const unfollow = (file: string) => {
    followed.get(file)?.close();
    followed.delete(file);
  };
  const follow = (file: string) => {
    if (stopped || followed.has(file)) return;
    if (followed.size >= FOLLOW_LIMIT) {
      const [oldest] = followed.keys();
      if (oldest !== undefined) unfollow(oldest);
    }
    try {
      const watcher = watch(file, () => seen(file));
      watcher.on("error", () => unfollow(file));
      followed.set(file, watcher);
    } catch {
      // Gone already.
    }
  };
  const seen = (file: string) => {
    let known = whose.get(file);
    if (!known) {
      known = codexRolloutOf(file, folder);
      whose.set(file, known);
    }
    void known.then((rollout) => {
      if (rollout) {
        follow(file);
        // A thread a conversation spawned: news of that conversation's row.
        if (rollout.parent) report("codex", rollout.parent, file, rollout.id);
        else report("codex", rollout.id, file);
      } else if (rollout === null) {
        // Not readable yet: asked again on its next write, which only its
        // own watch is sure to see.
        whose.delete(file);
        follow(file);
      } else {
        // Another folder's: cached, never opened again.
        unfollow(file);
      }
    });
  };
  try {
    watchers.push(
      watch(codexRoot, { recursive: true }, (_event, name) => {
        const match = name ? TRAILING_ID.exec(String(name)) : null;
        if (!match?.[1] || !basename(String(name)).startsWith("rollout-"))
          return;
        seen(join(codexRoot, String(name)));
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
    for (const file of [...followed.keys()]) unfollow(file);
  };
}
