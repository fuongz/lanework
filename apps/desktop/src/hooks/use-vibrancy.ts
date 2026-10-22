import { useEffect } from "react";

/**
 * Mark the document as translucent on macOS, so the window's native vibrancy
 * shows through instead of an opaque page background.
 *
 * NOTE: Call it once at the root, not per shell. In a shell, navigating to a
 * route outside it runs the cleanup and the window goes opaque for as long as
 * you stay there. Translucency belongs to the window, not to a route.
 */
export function useVibrancy(): void {
  useEffect(() => {
    let disposed = false;
    void window.desktop
      ?.getAppInfo()
      .then((info) => {
        if (!disposed && info.platform === "darwin")
          document.documentElement.dataset.vibrancy = "true";
      })
      .catch(() => {
        // Keep the opaque fallback when native app information is unavailable.
      });
    return () => {
      disposed = true;
      delete document.documentElement.dataset.vibrancy;
    };
  }, []);
}
