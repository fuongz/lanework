import { useEffect } from "react";
import { applyFonts } from "#/lib/fonts";
import { usePreferences } from "#/stores/preferences";

/** Follow the fonts picked in Settings → Appearance. */
export function useFonts(): void {
  const fonts = usePreferences((state) => state.fonts);
  useEffect(() => applyFonts(fonts), [fonts]);
}
