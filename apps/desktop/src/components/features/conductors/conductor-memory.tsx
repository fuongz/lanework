import { TaskDaily01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  type ConductorLedgerEntry,
  MEMORY_NOTES_MAX,
  type ConductorMemory as Memory,
  type SessionStatus,
} from "#/../shared/conductor-sessions";
import {
  ListSkeleton,
  TextSkeleton,
} from "#/components/shared/loading/skeletons";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Textarea } from "#/components/ui/textarea";
import { ipcMessage } from "#/lib/ipc-error";
import { relativeTime } from "#/lib/relative-time";
import { cn } from "#/lib/utils";

// A conductor's memory of one project (FE-128), on the Memory page of its
// dialog: the ledger main keeps of the sessions it started, read-only, and
// the notes it writes with `memory.write`, which the user may edit too.
//
// NOTE: Main sends no change event for memory: it is read when the page
// opens and again after a save.

const STATUS_LABELS: Record<SessionStatus, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  failed: "Failed",
  terminal: "In a terminal",
};

/** The Memory page: ledger above, notes below. */
export function ConductorMemory({
  project,
  conductor,
}: {
  project: string;
  /** The saved conductor, by id. */
  conductor: string;
}) {
  // Undefined while it is read; null when it could not be.
  const [memory, setMemory] = useState<Memory | null | undefined>(undefined);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const surface = window.desktop?.leads;
    if (!surface) {
      setMemory(null);
      setError("This window is not connected to the desktop app.");
      return;
    }
    let gone = false;
    surface
      .memory(project, conductor)
      .then((next) => {
        if (gone) return;
        setMemory(next);
        setNotes(next.notes);
      })
      .catch((failure: unknown) => {
        if (gone) return;
        setMemory(null);
        setError(ipcMessage(failure, "Could not read the memory."));
      });
    return () => {
      gone = true;
    };
  }, [project, conductor]);

  const save = async () => {
    const surface = window.desktop?.leads;
    if (!surface) return;
    setBusy(true);
    setError(null);
    try {
      await surface.saveMemoryNotes(project, conductor, notes);
      // Read back: main trims the notes, and the ledger may have moved.
      const next = await surface.memory(project, conductor);
      setMemory(next);
      setNotes(next.notes);
      setSaved(true);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not save the notes."));
    } finally {
      setBusy(false);
    }
  };

  const dirty = memory ? notes !== memory.notes : false;
  const over = notes.length > MEMORY_NOTES_MAX;
  const now = Date.now();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-2 border-b py-3 pr-12 pl-5">
        <h2 className="text-sm font-medium">Memory</h2>
        <span className="text-muted-foreground truncate text-xs">
          What it keeps of this project between conversations.
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-5">
        <section
          aria-labelledby="memory-ledger"
          className="flex flex-col gap-2"
        >
          <h3 id="memory-ledger" className="text-[13px] font-medium">
            Sessions it started
          </h3>
          {memory === undefined ? (
            <ListSkeleton
              label="Reading its sessions"
              rows={3}
              lines={2}
              className="px-0"
            />
          ) : memory === null ? null : memory.ledger.length === 0 ? (
            <Empty className="border p-5">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon
                    icon={TaskDaily01Icon}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                </EmptyMedia>
                <EmptyTitle>No sessions yet</EmptyTitle>
                <EmptyDescription>
                  Each session it starts in this project is listed here, with
                  how it ended, and stays when the conversation is reset.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-border flex flex-col divide-y rounded-lg border">
              {memory.ledger.map((entry) => (
                <LedgerRow key={entry.sessionId} entry={entry} now={now} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="memory-notes" className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h3 id="memory-notes" className="text-[13px] font-medium">
              Notes
            </h3>
            <span className="text-muted-foreground truncate text-xs">
              Decisions, conventions, open threads. It rewrites them as it
              works.
            </span>
          </div>
          {memory === undefined ? (
            <TextSkeleton
              label="Reading its notes"
              className="block h-40 w-full rounded-md"
            />
          ) : (
            <Textarea
              aria-label="Conductor notes"
              aria-invalid={over || undefined}
              value={notes}
              disabled={memory === null || busy}
              placeholder="Nothing yet. It writes here after a decision or a finished piece of work."
              onChange={(event) => {
                setNotes(event.target.value);
                setSaved(false);
              }}
              className="field-sizing-fixed min-h-40 resize-y font-mono"
            />
          )}
          <div className="flex items-center gap-3">
            <p
              role={error ? "alert" : undefined}
              className={cn(
                "mr-auto min-w-0 text-xs leading-snug",
                error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {error ??
                (saved && !dirty
                  ? "Saved. It reads them from its next message."
                  : "Saving replaces its notes for this project.")}
            </p>
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums",
                over ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {notes.length.toLocaleString()} /{" "}
              {MEMORY_NOTES_MAX.toLocaleString()}
            </span>
            <Button
              size="sm"
              disabled={!memory || !dirty || over || busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save notes"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One session of the ledger: agent, title, where it stands, what came of it. */
function LedgerRow({
  entry,
  now,
}: {
  entry: ConductorLedgerEntry;
  now: number;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <TerminalKindIcon kind={entry.agent} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-[13px] font-medium">
          {entry.title}
        </span>
        {entry.taskId && (
          <span className="text-muted-foreground shrink-0 font-mono text-xs">
            {entry.taskId}
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 text-xs",
            entry.status === "failed" || entry.status === "waiting"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {STATUS_LABELS[entry.status]}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {relativeTime(new Date(entry.updatedAt).toISOString(), now)}
        </span>
      </div>
      {entry.summary && (
        <p className="text-muted-foreground line-clamp-2 pl-5.5 text-xs leading-relaxed">
          {entry.summary}
        </p>
      )}
    </li>
  );
}
