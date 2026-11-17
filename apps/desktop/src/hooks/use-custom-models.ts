import { useEffect } from "react";
import { setCustomModels } from "#/../shared/conversation";
import { usePreferences } from "#/stores/preferences";

/**
 * Keep the user's own models (FE-146) known everywhere a model is checked:
 * this page's list, for the picker and a sent turn's settings, and main's,
 * which refuses a turn on a model it does not know.
 */
export function useCustomModels(): void {
  const custom = usePreferences((state) => state.customModels);
  const hydrated = usePreferences((state) => state.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    setCustomModels(custom);
    // `?.`: an older preload has no such call; the models stay this page's.
    void window.desktop?.conversation?.setCustomModels?.(custom).catch(() => {
      // Main keeps what it last had; the next change tries again.
    });
  }, [custom, hydrated]);
}
