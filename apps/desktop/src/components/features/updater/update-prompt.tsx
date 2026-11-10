import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import type { UpdaterLiveWork, UpdaterState } from "../../../../shared/updater";

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/** "2 terminals are running and 1 orchestration run is active." */
function liveSentence({ terminals, runs }: UpdaterLiveWork): string {
  const parts: string[] = [];
  if (terminals > 0)
    parts.push(
      `${terminals} ${plural(terminals, "terminal is", "terminals are")} running`,
    );
  if (runs > 0)
    parts.push(
      `${runs} ${plural(runs, "orchestration run is", "orchestration runs are")} active`,
    );
  return `${parts.join(" and ")}.`;
}

/**
 * The update prompt (INF-11/D4): shown once an update is downloaded.
 *
 * Restart now asks main to install. While terminals or runs are live, main
 * answers with how many instead, and the prompt asks again: Restart anyway
 * stops them. Later, Escape or a click outside close it; the update then
 * installs the next time Lanework quits.
 */
export function UpdatePrompt() {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [live, setLive] = useState<UpdaterLiveWork | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const updater = window.desktop?.updater;
    if (!updater) return;
    let disposed = false;
    const off = updater.onChange((next) => setState(next));
    void updater
      .get()
      .then((next) => {
        if (!disposed) setState(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const open = state?.status === "ready" && !state.postponed;

  // A new update, or the prompt closing, starts over from the first question.
  useEffect(() => {
    if (!open) {
      setLive(null);
      setBusy(false);
    }
  }, [open]);

  const later = () => {
    setLive(null);
    void window.desktop?.updater
      .later()
      .then(setState)
      .catch(() => {});
  };

  const restart = async () => {
    const updater = window.desktop?.updater;
    if (!updater) return;
    setBusy(true);
    try {
      const answer = await updater.install(live !== null);
      if (answer.result === "confirm") {
        setLive(answer.live);
        setBusy(false);
      } else if (answer.result === "not-ready") {
        setBusy(false);
        setState(await updater.get());
      }
      // `installing`: Lanework quits from here; the prompt stays as it is.
    } catch {
      setBusy(false);
    }
  };

  const version = state?.version ?? "";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) later();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {live ? "Restart with work still running?" : "Update ready"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {live
              ? `${liveSentence(live)} Restarting Lanework stops ${live.terminals + live.runs === 1 ? "it" : "them"}. Later installs Lanework ${version} the next time you quit instead.`
              : `Lanework ${version} is downloaded. Restart to start using it, or choose Later and it installs the next time you quit.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Later</AlertDialogCancel>
          <AlertDialogAction
            variant={live ? "destructive" : "default"}
            // `border-0`: without it the popup shows through as a 1px ring
            // (see account-section's Sign out for why it lives here).
            className="border-0"
            disabled={busy}
            onClick={() => void restart()}
          >
            {busy ? "Restarting…" : live ? "Restart anyway" : "Restart now"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
