import { useEffect, useState } from "react";
import { AGENT_NAME_MAX, type AgentSession } from "#/../shared/terminal";
import { TERMINAL_KIND_LABELS } from "#/components/shared/terminal/terminal-kind-icon";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { ipcMessage } from "#/lib/ipc-error";
import { useAgentSessions } from "#/stores/agent-sessions";

/**
 * Name an agent conversation in Lanework (FE-24/D4).
 *
 * The name is Lanework's alone (FE-24/D1). The CLI keeps its own title, which
 * is what the field falls back to, so emptying it is the way back, and the
 * placeholder says what that would be.
 */
export function RenameAgentDialog({
  project,
  session,
  onClose,
}: {
  project: string;
  /** The conversation being renamed; null keeps the dialog shut. */
  session: AgentSession | null;
  onClose: () => void;
}) {
  const rename = useAgentSessions((state) => state.rename);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh field every time it opens, holding the name the row shows.
  useEffect(() => {
    if (!session) return;
    setValue(session.title === session.cliTitle ? "" : session.title);
    setError(null);
  }, [session]);

  const save = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await rename(project, session, value);
      onClose();
    } catch (failure) {
      setError(ipcMessage(failure, "That name could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>
              The name is kept in Lanework only.{" "}
              {session
                ? `${TERMINAL_KIND_LABELS[session.agent]} keeps its own; leave this empty to use it again.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Session name"
            value={value}
            maxLength={AGENT_NAME_MAX}
            placeholder={session?.cliTitle}
            onChange={(event) => setValue(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
