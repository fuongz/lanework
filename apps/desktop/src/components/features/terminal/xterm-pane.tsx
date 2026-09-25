import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { TERMINAL_LIMITS, type TerminalSession } from "#/../shared/terminal";
import { readTerminalColors, terminalFontFamily } from "#/lib/terminal-theme";
import { useTerminal } from "#/stores/terminal";

/** How long a drag has to settle before the shell is told its new size. */
const RESIZE_SETTLE_MS = 60;

/**
 * One terminal on screen: an xterm attached to a session in the pty host.
 *
 * ⚠️ The view is disposable; the session is not. Unmounting — another tab,
 * another project, a hidden panel, a reload — DETACHES and nothing else. The
 * shell keeps running in the host, and the next mount is drawn from its
 * snapshot (FE-19/D3).
 *
 * ⚠️ xterm is imported lazily, inside the effect. It touches `window` when it
 * loads, and the production build prerenders the app shell with no window.
 *
 * ⚠️ Fitted BEFORE attaching. The host resizes to the geometry attach carries
 * and only then serializes; a snapshot taken at another width replays wrapped
 * wrong, and a TUI comes back as garbage.
 */
export function XtermPane({ session }: { session: TerminalSession }) {
  const host = useRef<HTMLDivElement>(null);
  const markExited = useTerminal((state) => state.markExited);

  useEffect(() => {
    const element = host.current;
    const surface = window.desktop?.terminal;
    if (!element || !surface) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      // One frame, so a panel that is still opening has its final size.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (disposed) return;

      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const term = new Terminal({
        fontFamily: terminalFontFamily(),
        fontSize: 12.5,
        lineHeight: 1.2,
        cursorStyle: "bar",
        cursorBlink: !reduced,
        scrollback: TERMINAL_LIMITS.scrollback,
        theme: readTerminalColors(),
        // ⌥ as Meta, the way Terminal.app's "Use Option as Meta key" does —
        // what word-jumps in a shell and every Emacs binding expect.
        macOptionIsMeta: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      cleanup.push(() => term.dispose());
      try {
        fit.fit();
      } catch {
        // A container with no size yet; the observer below fits it later.
      }

      cleanup.push(
        surface.attach(session.id, term.cols, term.rows, {
          onSnapshot: (data) => {
            term.reset();
            term.write(data);
          },
          onData: (data) => term.write(data),
          onExit: (code) => markExited(session.workspace, session.id, code),
        }),
      );

      const typing = term.onData((data) => surface.input(session.id, data));
      cleanup.push(() => typing.dispose());

      let settle: number | undefined;
      const resized = term.onResize(({ cols, rows }) => {
        window.clearTimeout(settle);
        settle = window.setTimeout(
          () => surface.resize(session.id, cols, rows),
          RESIZE_SETTLE_MS,
        );
      });
      cleanup.push(() => {
        resized.dispose();
        window.clearTimeout(settle);
      });

      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            // Collapsed to nothing mid-drag.
          }
        });
      });
      observer.observe(element);
      cleanup.push(() => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      });

      // Light and dark are a class on <html>; follow it.
      const theme = new MutationObserver(() => {
        term.options.theme = readTerminalColors();
      });
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      cleanup.push(() => theme.disconnect());

      term.focus();
    })();

    return () => {
      disposed = true;
      for (const undo of cleanup.reverse()) undo();
    };
  }, [session.id, session.workspace, markExited]);

  // ⚠️ The padding is on the WRAPPER. FitAddon measures the element xterm was
  // opened in, and padding on that element would be counted as room for text
  // — the last row and column would render under the edge.
  return (
    <div className="h-full min-h-0 px-3 pt-1.5 pb-1">
      <div ref={host} className="h-full w-full min-h-0 overflow-hidden" />
    </div>
  );
}
