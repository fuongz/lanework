import { useEffect } from "react";
import { usePreferences } from "#/stores/preferences";

/**
 * Design tokens hang off a `.dark` class (`@custom-variant dark` in app.css).
 *
 * ⚠️ Transitions are suppressed around the swap. A theme flip changes colour,
 * background, border and shadow on nearly every element at once, so everything
 * carrying a transition on those properties animates together and the switch
 * smears instead of snapping. Worse, only SOME elements have one — the search
 * input, the switch, the buttons — so they lag an otherwise instant repaint by
 * 150ms, which reads as a glitch rather than as motion.
 */
function applyDark(dark: boolean): void {
  const style = document.createElement("style");
  style.append(
    document.createTextNode("*,*::before,*::after{transition:none !important}"),
  );
  document.head.append(style);

  document.documentElement.classList.toggle("dark", dark);

  // Read for the side effect only: it forces a synchronous style flush, so the
  // new tokens resolve while the override is still in the document and no
  // transition ever starts.
  const _flushReflow = document.body.offsetHeight;

  // Two frames, not one: the override has to survive the paint that commits the
  // new colours, and come off before the next interaction.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => style.remove());
  });
}

/**
 * Follow the saved appearance preference — light, dark, or the system's.
 *
 * ⚠️ The renderer does NOT resolve "system", and deliberately does not read
 * `prefers-color-scheme`. That media query does NOT follow
 * `nativeTheme.themeSource` in this Electron build: with `themeSource` set to
 * "dark" and `shouldUseDarkColors` true, the renderer's query still reported
 * light. Main resolves the theme and says so — in the return value here, and
 * over `onThemeChange` when the OS changes it later.
 */
export function useTheme(): void {
  const theme = usePreferences((state) => state.theme);

  useEffect(() => {
    let disposed = false;
    void window.desktop
      ?.setTheme(theme)
      .then((dark) => {
        if (!disposed) applyDark(dark);
      })
      .catch(() => {
        // No bridge, or a rejected value: leave what is on screen rather than
        // forcing a theme nothing asked for.
      });
    return () => {
      disposed = true;
    };
  }, [theme]);

  useEffect(() => window.desktop?.onThemeChange(applyDark), []);
}
