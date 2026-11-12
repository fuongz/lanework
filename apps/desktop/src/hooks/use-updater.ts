import { useEffect, useState } from "react";
import type { UpdaterLiveWork, UpdaterState } from "../../shared/updater";

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

/** "2 terminals are running and 1 orchestration run is active." */
export function liveSentence({ terminals, runs }: UpdaterLiveWork): string {
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

/** The updater's state, kept current from main (INF-11). */
export function useUpdaterState(): [
  UpdaterState | null,
  (next: UpdaterState) => void,
] {
  const [state, setState] = useState<UpdaterState | null>(null);
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
  return [state, setState];
}

/**
 * What a person can do about an update: download it, put it off, restart.
 *
 * Restart asks main to install. While terminals or runs are live, main
 * answers with how many instead (`live`), and the caller asks again; the
 * second `restart` goes ahead over them. A new version, or the update going
 * away, starts over from the first question.
 */
export function useUpdateActions(
  state: UpdaterState | null,
  setState: (next: UpdaterState) => void,
) {
  const [live, setLive] = useState<UpdaterLiveWork | null>(null);
  const [busy, setBusy] = useState(false);
  const key = `${state?.status}:${state?.version}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the update changes.
  useEffect(() => {
    setLive(null);
    setBusy(false);
  }, [key]);

  const download = () => {
    void window.desktop?.updater
      .download()
      .then(setState)
      .catch(() => {});
  };

  const later = () => {
    setLive(null);
    void window.desktop?.updater
      .later()
      .then(setState)
      .catch(() => {});
  };

  const cancelRestart = () => setLive(null);

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
      // `installing`: Lanework quits from here; leave everything as it is.
    } catch {
      setBusy(false);
    }
  };

  return { live, busy, download, later, restart, cancelRestart };
}
