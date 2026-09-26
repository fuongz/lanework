import { useEffect, useState } from "react";

/**
 * Whether the window is in dark mode, kept in step.
 *
 * ⚠️ Read from the `dark` class on `<html>`, NOT from `prefers-color-scheme`.
 * `use-theme.ts` documents why: that media query does not follow
 * `nativeTheme.themeSource` in this Electron build, so main resolves the theme
 * and the class is the only thing in the renderer that is reliably true.
 * `@pierre/diffs`' own `themeType: 'system'` and `@pierre/trees`' `light-dark()`
 * defaults would both consult the broken query.
 *
 * ⚠️ In `hooks/` it would be wrong: it is used by the diff and by the file tree
 * beside it, which the layout audit counts as ONE area — a hook with a single
 * owner colocates with that owner. It sits here, as a satellite of the diff
 * view, for exactly that reason.
 */
export function useDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document === "undefined"
      ? false
      : document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark")),
    );
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
