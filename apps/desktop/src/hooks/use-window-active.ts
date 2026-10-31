import { useEffect } from "react";

/**
 * Mark the document while the window is not the one in front (blurred, or
 * hidden), so `app.css` can pause the endless "working" motion: shimmer,
 * orbit, ping, spin, pulse.
 *
 * Nobody watches them then, yet each one repaints at 60 fps: one shimmering
 * title alone kept the renderer and the GPU near 9% each (FE-113). Paused,
 * they hold a still frame, so the dot and the text still say "working".
 *
 * NOTE: Call it once at the root, like `useVibrancy`: the state belongs to
 * the window, not to a route.
 */
export function useWindowActive(): void {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      if (document.hasFocus() && !document.hidden)
        delete root.dataset.windowInactive;
      else root.dataset.windowInactive = "";
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      delete root.dataset.windowInactive;
    };
  }, []);
}
