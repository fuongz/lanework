import { useEffect } from "react";

/**
 * Mark the document as translucent on macOS, so the window's native vibrancy
 * shows through instead of an opaque page background.
 *
 * ⚠️ Called ONCE at the root, not per shell. It used to live in `AppShell`,
 * which meant navigating to a route outside that shell ran the cleanup and
 * turned vibrancy off — the window went opaque for as long as you stayed there.
 * Translucency is a property of the WINDOW; nothing about which route is open
 * should change it.
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
