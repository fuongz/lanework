import { useMemo, useState } from "react";
import type { AgentSession } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import { relativeTime } from "#/lib/board-view";

/**
 * The Agents group's search: every conversation of this project — Claude
 * Code's and Codex's alike, past the rail's fold and the pinned ones too —
 * by its title, newest first.
 *
 * ⚠️ Filtered here (`shouldFilter={false}`), not by cmdk: cmdk ranks what it
 * is handed and reorders the list, and newest first is the order that finds
 * a conversation.
 *
 * ⚠️ Titles only (the Lanework name and the CLI's own), never the
 * transcripts: those are read from disk one conversation at a time, and a
 * search box that read them all on each keystroke would stall the window.
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
  const now = Date.now();
  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={change}
      title="Search conversations"
      description="Find a Claude Code or Codex conversation in this project"
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search conversations…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-96">
          <CommandEmpty>No conversation matches.</CommandEmpty>
          {matched.map((session) => (
            <CommandItem
              key={`${session.agent}:${session.id}`}
              value={`${session.agent}:${session.id}`}
              onSelect={() => {
                onPick(session);
                change(false);
              }}
            >
              <TerminalKindIcon
                kind={session.agent}
                className="size-3.5 shrink-0"
              />
              {/* ⚠️ The title takes the room, so the time sits on the right
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
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
