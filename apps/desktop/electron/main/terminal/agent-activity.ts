// Which agent conversations are being written right now (FE-25/D3): the
// transcripts a project's folder has, watched rather than polled.
//
// Since FE-112 a settled write is also read into Lanework's session store,
// for a conversation the store has: what the rail lists stays up to date
// without a Pull, and a conversation it does not have is left alone.
//
// Nothing here imports Electron, so a spec can drive it under plain Node
// against a fake home folder.
import { existsSync, type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AgentCard,
  isAgentSessionId,
  isWorkflowRunId,
  type TerminalAgent,
  workflowAgentKey,
} from "../../../shared/terminal";
import type { SessionStore } from "../../session-store";
import { type IngestSource, ingestOne } from "../sessions";
import {
  CLAUDE_SUBAGENT_FILE,
  claudeProjectDir,
  codexRolloutOf,
  lastCardIn,
  STALE_MS,
  transcriptCompleted,
  transcriptWorking,
} from "./agent-sessions";
import { opencodeChanges, opencodeDataDirOf } from "./opencode-sessions";

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
 * `<conversation>/subagents/workflows/<run>/agent-<id>.jsonl`: a workflow's
 * agent (FE-01).
 */
const CLAUDE_WORKFLOW_AGENT_PATH =
  /^([^/\\]+)[/\\]subagents[/\\]workflows[/\\]([^/\\]+)[/\\]([^/\\]+)$/;

/** Where the watcher reads settled writes into (FE-112). */
export interface WatchSessions {
  /** Lanework's session store; one that throws (closed) ends the reads. */
  store: () => SessionStore;
  /** The project whose rail the folder's conversations are listed on. */
  project: string;
  /**
   * After a read changed conversation `key`'s row: `appeared` when it now
   * has a title it had not, so the rail lists it for the first time.
   */
  onIngested?: (key: string, appeared: boolean) => void;
}

/** What {@link ingestSession} came to. */
export interface SessionIngest {
  /** The store changed. */
  written: boolean;
  /** The row has a title it had not before: the rail lists it now. */
  appeared: boolean;
}

const UNREAD: SessionIngest = { written: false, appeared: false };

/**
 * Read conversation `key`'s new bytes into the store (FE-112).
 *
 * Only one the store already has, for `project` or for none yet (a stub a
 * legacy mark made): a conversation started outside Lanework joins through
 * a Pull, never through a write, and one listed on another project stays
 * there.
 *
 * @param key `agent:id`; for a Codex thread, the conversation that spawned
 *   it.
 * @param create Read it in though the store has no row: one main is sure
 *   about, such as one just brought back from the archive.
 */
export async function ingestSession(
  store: SessionStore,
  key: string,
  source: IngestSource,
  options: { project: string; folder: string; home: string; create?: boolean },
): Promise<SessionIngest> {
  const { project, folder, home } = options;
  const before = store.getSession(key);
  if (!before && !options.create) return UNREAD;
  if (before?.project && before.project !== project) return UNREAD;
  const { written } = await ingestOne(store, source, { project, folder, home });
  if (!written) return UNREAD;
  return {
    written,
    appeared: !before?.cliTitle && Boolean(store.getSession(key)?.cliTitle),
  };
}

/**
 * Watch `folder`'s Claude and Codex transcripts under `home`, and call
 * `onActivity` when one is written.
 *
 * The id comes from the file NAME (`<id>.jsonl` for Claude, a rollout ending
 * in its id for Codex), so a write costs no read of the listing. Codex keeps
 * every folder's rollouts in one tree, so a rollout seen for the first time
 * is opened once to learn whose it is, and the answer is kept.
 *
 * Claude's folder for `folder`, when Claude has not made it yet, is watched
 * for once it does. Codex's and OpenCode's are one per machine: missing,
 * they are not watched.
 *
 * @param onCompleted Called when a turn that was running ends complete.
 * @param sessions Where a settled write of a conversation the store has is
 *   read into, before anything is told of it (FE-112).
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
  sessions?: WatchSessions,
): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, NodeJS.Timeout>();
  const said = new Map<string, string>();
  const running = new Set<string>();
  // The sub-agents last reported working, per conversation, by their files.
  // A stopped one writes nothing more; its conversation's next write is when
  // it is read again.
  const busySubagents = new Map<string, Map<string, string>>();
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

  // One read into the store per source at a time, and at most one more
  // queued behind it: every write a read in flight missed is read by that
  // one. A busy conversation's sub-agents each settle on their own, and
  // each is news of the same transcript.
  const reading = new Map<string, Promise<void>>();
  const queued = new Map<string, Promise<void>>();
  const readIn = async (key: string, source: IngestSource) => {
    if (!sessions || stopped) return;
    try {
      const read = await ingestSession(sessions.store(), key, source, {
        project: sessions.project,
        folder,
        home,
      });
      if (read.written && !stopped) sessions.onIngested?.(key, read.appeared);
    } catch {
      // The store closed, or the file went: the next write reads it again.
    }
  };
  const ingest = (key: string, source: IngestSource): Promise<void> => {
    if (!sessions) return Promise.resolve();
    const lock =
      source.agent === "opencode" ? `opencode:${source.id}` : source.file;
    const waiting = queued.get(lock);
    if (waiting) return waiting;
    const running = reading.get(lock);
    if (running) {
      const next = running.then(() => {
        queued.delete(lock);
        return ingest(key, source);
      });
      queued.set(lock, next);
      return next;
    }
    const run = readIn(key, source).finally(() => reading.delete(lock));
    reading.set(lock, run);
    return run;
  };

  // With `subagent` set, it is that sub-agent of `id` that was written: its
  // own state, no card, and no `onWrite`, since a sub-agent is never the
  // conversation a tab is on.
  // Only the CLIs whose transcripts are files watched here report.
  const report = (
    agent: "claude" | "codex",
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
        void (async () => {
          // NOTE: Into the store FIRST (FE-112): the rail that lists again on
          // this news finds the conversation as it is now. A sub-agent's write
          // reads its conversation's transcript, whose read lists them.
          await ingest(
            `${agent}:${id}`,
            agent === "claude"
              ? { agent, file: join(claudeDir, `${id}.jsonl`) }
              : { agent, file },
          );
          if (!stopped && !subagent) onWrite?.(agent, id);
          const working = await transcriptWorking(
            file,
            agent,
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
              (await transcriptCompleted(file, agent))
            ) {
              if (!stopped) onCompleted(agent, id);
            }
          }
          if (stopped) return;
          const parentKey = `${agent}:${id}`;
          if (subagent) {
            const busy = busySubagents.get(parentKey) ?? new Map();
            if (working) busy.set(subagent, file);
            else busy.delete(subagent);
            busySubagents.set(parentKey, busy);
          } else if (agent === "claude") {
            // NOTE: A sub-agent stopped mid-turn (TaskStop) never closes its
            // turn in its own file, so no write of it will say it is done.
            // Its conversation is told instead: read it again from there.
            for (const [sub, subFile] of busySubagents.get(parentKey) ?? []) {
              if (await transcriptWorking(subFile, "claude", true)) continue;
              busySubagents.get(parentKey)?.delete(sub);
              if (!stopped) onActivity(agent, id, false, null, sub);
            }
          }
          if (!subagent && said.get(key) === news) return;
          said.set(key, news);
          onActivity(agent, id, working, card, subagent);
        })();
      }, SETTLE_MS),
    );
  };

  const claudeDir = join(home, ".claude", "projects", claudeProjectDir(folder));
  const watchClaude = (): boolean => {
    let conversations: FSWatcher;
    try {
      conversations = watch(claudeDir, (_event, name) => {
        const id = name ? basename(String(name)).replace(/\.jsonl$/, "") : "";
        if (name && String(name).endsWith(".jsonl") && isAgentSessionId(id))
          report("claude", id, join(claudeDir, `${id}.jsonl`));
      });
    } catch {
      // No Claude conversations for this folder yet.
      return false;
    }
    conversations.on("error", () => conversations.close());
    watchers.push(conversations);
    watchSubagents();
    return true;
  };
  // NOTE: A sub-agent writes its OWN transcript, one folder down, while its
  // conversation's may sit still, as a background agent's does. It gets its
  // own recursive watch, so the conversations' watch above stays as it is.
  const watchSubagents = () => {
    try {
      const subagents = watch(
        claudeDir,
        { recursive: true },
        (_event, name) => {
          const match = name ? CLAUDE_SUBAGENT_PATH.exec(String(name)) : null;
          const sub = match?.[2]
            ? CLAUDE_SUBAGENT_FILE.exec(match[2])?.[1]
            : null;
          if (match?.[1] && sub && isAgentSessionId(match[1])) {
            report("claude", match[1], join(claudeDir, String(name)), sub);
            return;
          }
          // A workflow's agent: news of its run's row, keyed `<run>/<id>`.
          const agent = name
            ? CLAUDE_WORKFLOW_AGENT_PATH.exec(String(name))
            : null;
          const id = agent?.[3]
            ? CLAUDE_SUBAGENT_FILE.exec(agent[3])?.[1]
            : null;
          if (
            agent?.[1] &&
            id &&
            isAgentSessionId(agent[1]) &&
            isWorkflowRunId(agent[2])
          )
            report(
              "claude",
              agent[1],
              join(claudeDir, String(name)),
              workflowAgentKey(agent[2], id),
            );
        },
      );
      subagents.on("error", () => subagents.close());
      watchers.push(subagents);
    } catch {
      // Gone again since.
    }
  };
  // NOTE: A folder no Claude has run in yet has no folder of Claude's. Once
  // the rail no longer reads the folder on each listing (FE-112), only this
  // watch reads a first conversation there into the store, so it waits for
  // Claude to make the folder rather than give up on it.
  if (!watchClaude()) {
    try {
      const projects = dirname(claudeDir);
      const waiter = watch(projects, (_event, name) => {
        if (stopped || String(name) !== basename(claudeDir)) return;
        if (!existsSync(claudeDir) || !watchClaude()) return;
        waiter.close();
      });
      waiter.on("error", () => waiter.close());
      watchers.push(waiter);
    } catch {
      // Claude has never run here: nothing to wait for.
    }
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

  // OpenCode (FE-104): one database for every folder, written through its
  // WAL. A write of it is read, once settled, for this folder's sessions
  // written since the last look.
  const opencodeDir = opencodeDataDirOf(home);
  // When each session was last seen written, and whether it was working.
  const opencodeSeen = new Map<string, { updated: number; working: boolean }>();
  let opencodeSince = Date.now() - STALE_MS;
  let opencodeTimer: NodeJS.Timeout | null = null;
  let opencodeReading = false;
  const opencodeCheck = async () => {
    // NOTE: A session still working is looked at again whether or not it
    // was written since: its turn may have closed on a write to another
    // table.
    let since = opencodeSince;
    for (const seen of opencodeSeen.values())
      if (seen.working) since = Math.min(since, seen.updated);
    const changes = await opencodeChanges(opencodeDir, folder, since);
    if (stopped) return;
    // Into the store first (FE-112), as a transcript's write is: a
    // sub-agent's change is its conversation's, whose read lists them.
    for (const id of new Set(changes.map((change) => change.root ?? change.id)))
      await ingest(`opencode:${id}`, { agent: "opencode", id });
    if (stopped) return;
    for (const change of changes) {
      opencodeSince = Math.max(opencodeSince, change.updated);
      const before = opencodeSeen.get(change.id);
      opencodeSeen.set(change.id, {
        updated: change.updated,
        working: change.working,
      });
      const written = !before || change.updated > before.updated;
      if (change.root) {
        // A sub-agent: every settled write of it is news, as Claude's is.
        if (written || before?.working !== change.working)
          onActivity("opencode", change.root, change.working, null, change.id);
        continue;
      }
      if (written) onWrite?.("opencode", change.id);
      if (before?.working === change.working) continue;
      // First seen idle: nothing changed that a row shows.
      if (!before && !change.working) continue;
      onActivity("opencode", change.id, change.working, null, null);
      if (before?.working && !change.working && change.succeeded)
        onCompleted?.("opencode", change.id);
    }
    // Keep the map to what can still move.
    if (opencodeSeen.size > 256)
      for (const [id, seen] of opencodeSeen)
        if (!seen.working && seen.updated < opencodeSince - STALE_MS)
          opencodeSeen.delete(id);
  };
  const opencodeWritten = () => {
    if (stopped || opencodeTimer) return;
    opencodeTimer = setTimeout(() => {
      opencodeTimer = null;
      // One read at a time; a write during it is read on the next settle.
      if (opencodeReading) return opencodeWritten();
      opencodeReading = true;
      void opencodeCheck()
        .catch(() => undefined)
        .finally(() => {
          opencodeReading = false;
        });
    }, SETTLE_MS);
  };
  try {
    watchers.push(
      watch(opencodeDir, (_event, name) => {
        const file = name ? String(name) : "";
        if (file === "opencode.db" || file === "opencode.db-wal")
          opencodeWritten();
      }),
    );
  } catch {
    // No OpenCode on this machine.
  }

  for (const watcher of watchers) watcher.on("error", () => watcher.close());
  return () => {
    stopped = true;
    if (opencodeTimer) clearTimeout(opencodeTimer);
    for (const timer of pending.values()) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const file of [...followed.keys()]) unfollow(file);
  };
}
