import { useParams } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { MatchLine, SessionMatch } from "#/../shared/fs-search";
import type { AgentSession } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import { relativeTime } from "#/lib/relative-time";

/** How long typing must pause before the transcripts are searched. */
const DEBOUNCE_MS = 250;
/** The shortest query the transcripts are searched for. */
const BODY_MIN = 2;

/** A conversation's key across the CLIs: ids are only unique per agent. */
const keyOf = (agent: string, id: string) => `${agent}:${id}`;

/**
 * The Agents group's search: every conversation of this project, newest
 * first, by title, then by what was said in it (FE-149).
 *
 * Claude Code's, Codex's and OpenCode's alike, past the rail's fold, pinned
 * ones too.
 *
 * - Filtered here (`shouldFilter={false}`), not by cmdk: cmdk ranks what it
 *   is handed and reorders the list, and newest first is the order that
 *   finds a conversation.
 * - Titles match as you type. The transcripts are searched in main, through
 *   ripgrep, once typing pauses; main drops a window's last search when a
 *   new one comes. A conversation whose title matched is not listed again
 *   under "In conversations".
 * - Only a conversation the rail has can be opened, so a match in a
 *   transcript Lanework has not pulled in is left out.
 */
export function AgentSessionSearch({
  open,
  onOpenChange,
  sessions,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: AgentSession[];
  onPick: (session: AgentSession) => void;
}) {
  const [query, setQuery] = useState("");
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      ),
    [sessions],
  );
  // Every word somewhere in the titles or the agent's name, in any order.
  const matched = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return ordered;
    return ordered.filter((session) => {
      const text =
        `${session.title} ${session.cliTitle} ${TERMINAL_KIND_LABELS[session.agent]}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [ordered, query]);
  const body = useBodySearch(open ? query : "", slug);
  // What was said, in the rail's conversations whose title did not match.
  const inBody = useMemo(() => {
    if (!body.matches) return [];
    const byKey = new Map(
      sessions.map((session) => [keyOf(session.agent, session.id), session]),
    );
    const titled = new Set(
      matched.map((session) => keyOf(session.agent, session.id)),
    );
    return body.matches.flatMap((match) => {
      const key = keyOf(match.harness, match.sessionId);
      const session = byKey.get(key);
      return session && !titled.has(key) ? [{ session, match }] : [];
    });
  }, [body.matches, sessions, matched]);
  const now = Date.now();
  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };
  const pick = (session: AgentSession) => {
    onPick(session);
    change(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={change}
      title="Search conversations"
      description="Find a conversation in this project by its title or by what was said in it"
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search conversations…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-96">
          {/* Not while the transcripts are still being read: a match may
              yet come from them. */}
          {!body.searching && (
            <CommandEmpty>No conversation matches.</CommandEmpty>
          )}
          {matched.length > 0 && (
            <CommandGroup heading={query.trim() ? "Titles" : undefined}>
              {matched.map((session) => (
                <CommandItem
                  key={keyOf(session.agent, session.id)}
                  value={keyOf(session.agent, session.id)}
                  onSelect={() => pick(session)}
                >
                  <TerminalKindIcon
                    kind={session.agent}
                    className="size-3.5 shrink-0"
                  />
                  {/* The title takes the room, so the time sits on the right
                      edge: the item's hidden tick has `ml-auto` too. */}
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={TERMINAL_KIND_LABELS[session.agent]}
                  >
                    {session.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {relativeTime(session.updatedAt, now)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {inBody.length > 0 && (
            <CommandGroup heading="In conversations">
              {inBody.map(({ session, match }) => (
                <CommandItem
                  key={`body:${keyOf(session.agent, session.id)}`}
                  value={`body:${keyOf(session.agent, session.id)}`}
                  onSelect={() => pick(session)}
                  className="items-start"
                >
                  <TerminalKindIcon
                    kind={session.agent}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="truncate"
                      title={TERMINAL_KIND_LABELS[session.agent]}
                    >
                      {session.title}
                    </span>
                    {match.lines[0] && (
                      <Snippet
                        line={match.lines[0]}
                        className="text-muted-foreground line-clamp-2 text-xs"
                      />
                    )}
                  </span>
                  <span className="text-muted-foreground shrink-0 self-center text-xs tabular-nums">
                    {relativeTime(session.updatedAt, now)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {body.searching && (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              Searching what was said…
            </p>
          )}
          {body.error && (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              {body.error}
            </p>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** A matching line, its matches in the foreground. */
function Snippet({ line, className }: { line: MatchLine; className: string }) {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of line.ranges) {
    if (start < at) continue;
    if (start > at)
      parts.push({ text: line.text.slice(at, start), hit: false });
    parts.push({ text: line.text.slice(start, end), hit: true });
    at = end;
  }
  if (at < line.text.length)
    parts.push({ text: line.text.slice(at), hit: false });
  return (
    <span className={className}>
      {parts.map((part, index) => (
        // The parts never reorder: their index is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <Fragment key={index}>
          {part.hit ? (
            <mark className="text-foreground bg-transparent font-medium">
              {part.text}
            </mark>
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The transcripts searched for `query` once typing pauses, in project
 * `slug`'s folders (every folder's without one).
 *
 * An answer to a query since typed over is dropped: main aborts that search,
 * and a late answer never replaces a newer one.
 */
function useBodySearch(
  query: string,
  slug: string | undefined,
): {
  matches: SessionMatch[] | null;
  searching: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    query: string;
    matches: SessionMatch[] | null;
    error: string | null;
  }>({ query: "", matches: null, error: null });
  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < BODY_MIN) return;
    const api = window.desktop?.fsSearch;
    if (!api) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .searchSessions(trimmed, slug ? { project: slug } : {})
        .then((matches) => {
          if (live) setState({ query: trimmed, matches, error: null });
        })
        .catch((error: unknown) => {
          if (!live) return;
          setState({
            query: trimmed,
            matches: null,
            error:
              error instanceof Error && /too long/i.test(error.message)
                ? "Searching what was said took too long."
                : "What was said could not be searched.",
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trimmed, slug]);
  if (trimmed.length < BODY_MIN || !window.desktop?.fsSearch)
    return { matches: null, searching: false, error: null };
  // An answer to an earlier query is not this one's.
  if (state.query !== trimmed)
    return { matches: null, searching: true, error: null };
  return { matches: state.matches, searching: false, error: state.error };
}
