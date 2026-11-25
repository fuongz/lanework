import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { AgentSession, TerminalAgent } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { Badge } from "#/components/ui/badge";
import { agentKey, useAgentSessions } from "#/stores/agent-sessions";
import { useBoard } from "#/stores/board";
import { usePulls } from "#/stores/pulls";
import type { PullDetail } from "../../../../shared/git";

/**
 * Which of a pull request's files agent conversations wrote (FE-171), read
 * from the same transcripts as the marks on Changes (FE-39).
 *
 * Read in Lanework only; nothing is written to GitHub (FE-171/D1a).
 */

/** One conversation that edited a file of the pull request. */
export interface AgentContributor {
  agent: TerminalAgent;
  id: string;
  title: string;
  /** The card's task id when the conversation named one, else null. */
  card: string | null;
  /** Its newest edit of the file, ISO. */
  lastAt: string;
}

/** A file of the pull request and the conversations that edited it. */
export interface AgentContribution {
  path: string;
  by: AgentContributor[];
}

/**
 * How far before the pull request's oldest commit an edit still counts.
 *
 * NOTE: Work starts before its first commit, and a rebase re-stamps every
 * commit, so the oldest commit time is a late bound. The merge base's date
 * would be exact, but nothing in the renderer reads it.
 */
const LEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** The most conversations read for one pull request, newest moved first. */
const MAX_SESSIONS = 40;
/** Transcripts read at once: each is a file scan in main. */
const BATCH = 6;
/** A task id as the board writes one (`FE-171`), not a card's uuid. */
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/i;

/** When a conversation last moved, its sub-agents included (as main reads). */
function lastMoved(session: AgentSession): number {
  return Math.max(
    Date.parse(session.updatedAt) || 0,
    ...session.subagents.map((sub) => Date.parse(sub.updatedAt) || 0),
  );
}

/**
 * The pull request's files that agent conversations of `project` edited,
 * by path; null while reading.
 *
 * Only conversations Lanework lists for the project count, and only edits
 * made with the agents' file tools: a file changed through the shell carries
 * no mark, which is not proof an agent did not write it.
 */
export function useAgentContribution(
  project: string | null,
  detail: PullDetail,
): { rows: AgentContribution[] | null; partial: boolean } {
  const { pull } = detail;
  const sessions = useAgentSessions((state) =>
    project ? state.byProject[project] : undefined,
  );
  const loadSessions = useAgentSessions((state) => state.load);
  const commits = usePulls((state) => state.commits);
  const commitsLoading = usePulls((state) => state.commitsLoading);
  const commitsError = usePulls((state) => state.commitsError);
  const loadCommits = usePulls((state) => state.loadCommits);

  useEffect(() => {
    if (project && !sessions) void loadSessions(project);
  }, [project, sessions, loadSessions]);

  // The same list the commit menu reads, so opening it afterwards is free.
  useEffect(() => {
    if (commits === null && !commitsLoading && commitsError === null)
      void loadCommits(pull.number);
  }, [commits, commitsLoading, commitsError, loadCommits, pull.number]);

  // Without commits (a failed read), the pull request's own age stands in.
  const since = useMemo(() => {
    const times = (commits ?? [])
      .map((commit) => Date.parse(commit.committedAt))
      .filter((time) => Number.isFinite(time));
    const oldest = times.length
      ? Math.min(...times)
      : Date.parse(pull.createdAt) || 0;
    return oldest - LEAD_MS;
  }, [commits, pull.createdAt]);
  const ready = commits !== null || commitsError !== null;

  // NOTE: Keyed by ids, not the list: the list is replaced on every turn of
  // every running agent, and re-reading 40 transcripts for that is waste.
  const candidates = useMemo(
    () =>
      (sessions ?? [])
        .filter((session) => lastMoved(session) >= since)
        .sort((a, b) => lastMoved(b) - lastMoved(a))
        .slice(0, MAX_SESSIONS),
    [sessions, since],
  );
  const which = candidates.map(agentKey).join("\n");

  const [found, setFound] = useState<{
    key: string;
    touches: Map<string, { session: AgentSession; lastAt: string }[]>;
    partial: boolean;
  } | null>(null);
  const files = detail.files;
  const listed = sessions !== undefined;
  const readKey = `${project}:${pull.number}:${detail.headSha}:${since}:${which}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `readKey` names every input
  useEffect(() => {
    const surface = window.desktop?.terminal;
    if (!project || !sessions || !ready || !surface) return;
    let gone = false;
    const wanted = new Set<string>();
    for (const file of files) {
      wanted.add(file.path);
      if (file.previousPath) wanted.add(file.previousPath);
    }
    void (async () => {
      const touches = new Map<
        string,
        { session: AgentSession; lastAt: string }[]
      >();
      let partial = false;
      for (let start = 0; start < candidates.length; start += BATCH) {
        const batch = candidates.slice(start, start + BATCH);
        const read = await Promise.all(
          batch.map((session) =>
            surface
              .agentFiles(project, session.agent, session.id)
              .catch(() => null),
          ),
        );
        if (gone) return;
        read.forEach((answer, index) => {
          const session = batch[index];
          if (!answer || !session) return;
          partial ||= answer.partial;
          for (const touch of answer.files) {
            if (!wanted.has(touch.path)) continue;
            if ((Date.parse(touch.lastAt) || 0) < since) continue;
            const list = touches.get(touch.path) ?? [];
            list.push({ session, lastAt: touch.lastAt });
            touches.set(touch.path, list);
          }
        });
      }
      if (!gone) setFound({ key: readKey, touches, partial });
    })();
    return () => {
      gone = true;
    };
  }, [readKey, ready, listed]);

  // Cards are read live, not with the files: an agent names one mid-turn.
  const liveCards = useAgentSessions((state) => state.cards);
  const boardCards = useBoard((state) =>
    state.view?.projectId === project ? state.view.cards : null,
  );

  const rows = useMemo(() => {
    if (!found || found.key !== readKey) return null;
    const taskIds = new Map(
      (boardCards ?? []).map((card) => [card.id, card.taskId]),
    );
    /** The card it named on this board, as a task id, or null. */
    const cardOf = (session: AgentSession): string | null => {
      const key = agentKey(session);
      const on = key in liveCards ? liveCards[key] : session.card;
      if (!on || on.boardId !== project) return null;
      const taskId = taskIds.get(on.card);
      if (taskId) return taskId;
      return TASK_ID.test(on.card) ? on.card.toUpperCase() : null;
    };
    // Renamed files are found under either name, and drawn under the new one.
    const byPath = new Map<string, AgentContributor[]>();
    for (const file of files) {
      const seen = new Set<string>();
      const by: AgentContributor[] = [];
      const names = file.previousPath
        ? [file.path, file.previousPath]
        : [file.path];
      for (const name of names)
        for (const { session, lastAt } of found.touches.get(name) ?? []) {
          const key = agentKey(session);
          if (seen.has(key)) continue;
          seen.add(key);
          by.push({
            agent: session.agent,
            id: session.id,
            title: session.title,
            card: cardOf(session),
            lastAt,
          });
        }
      if (by.length === 0) continue;
      by.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      byPath.set(file.path, by);
    }
    return [...byPath]
      .map(([path, by]) => ({ path, by }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [found, readKey, files, liveCards, boardCards, project]);

  return { rows, partial: found?.key === readKey && found.partial };
}

/**
 * The files agents wrote, one row per file, each conversation that edited it
 * under its name with a link that opens it (FE-171/D2).
 */
export function AgentContributionList({
  slug,
  rows,
  partial,
}: {
  slug: string;
  rows: AgentContribution[];
  partial: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.path} className="flex min-w-0 flex-col gap-1.5">
            <span className="truncate font-mono text-xs" title={row.path}>
              {row.path}
            </span>
            <ul className="flex flex-col gap-1">
              {row.by.map((who) => (
                <li
                  key={`${who.agent}:${who.id}`}
                  className="flex items-start gap-2 text-xs"
                >
                  <TerminalKindIcon
                    kind={who.agent}
                    className="mt-px size-3.5 shrink-0"
                  />
                  <span className="text-muted-foreground shrink-0">
                    {TERMINAL_KIND_LABELS[who.agent]}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={who.title}>
                    {who.title}
                  </span>
                  {who.card && (
                    <Badge
                      variant="outline"
                      className="shrink-0 self-center font-mono"
                    >
                      {who.card}
                    </Badge>
                  )}
                  <Link
                    to="/w/$slug/agents/chat/$conversation"
                    params={{ slug, conversation: who.id }}
                    aria-label={`Open “${who.title}”`}
                    className="text-accent-brand shrink-0 self-center hover:underline"
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs/relaxed">
        Counts edits agents made with their file tools in this project's
        conversations. Edits made through a shell are not counted.
        {partial &&
          " Some long conversations were read only in part, so older edits may be missing."}
      </p>
    </div>
  );
}
