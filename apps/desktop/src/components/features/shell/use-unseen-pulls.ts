import { useEffect, useState } from "react";

/**
 * New pull requests in `slug`'s repository, yours included, not seen yet
 * (FE-76).
 *
 * Main counts them, from its 2-minute watcher and from the Pull requests
 * screen's own reads, and clears a project's count once its Pull requests tab
 * is on screen. This only listens. 0 outside the desktop app.
 */
export function useUnseenPulls(slug: string | undefined): number {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const api = window.desktop?.notifications;
    if (!api) return;
    let live = true;
    void api
      .unseenPulls()
      .then((next) => {
        if (live) setCounts(next);
      })
      .catch(() => {});
    const off = api.onUnseenPulls(setCounts);
    return () => {
      live = false;
      off();
    };
  }, []);

  return slug ? (counts[slug] ?? 0) : 0;
}
