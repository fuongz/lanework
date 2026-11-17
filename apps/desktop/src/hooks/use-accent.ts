import { useEffect } from "react";
import { applyAccent } from "#/lib/accent";
import { usePreferences } from "#/stores/preferences";

/** Follow the accent colour picked in Settings → Appearance (FE-143). */
export function useAccent(): void {
  const accent = usePreferences((state) => state.accent);
  useEffect(() => applyAccent(accent), [accent]);
}
