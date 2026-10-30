import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { TERMINAL_LIMITS, type TerminalSession } from "#/../shared/terminal";
import { fontStack } from "#/lib/fonts";
import { readTerminalColors } from "#/lib/terminal-theme";
import { usePreferences } from "#/stores/preferences";
import { useTerminal } from "#/stores/terminal";

/** How long a drag has to settle before the shell is told its new size. */
const RESIZE_SETTLE_MS = 60;

/**
 * What ⇧↩ sends: ESC + CR, the same bytes Claude Code's `/terminal-setup`
 * binds it to. Claude Code and Codex read it as "new line, don't submit"; zsh
 * inserts a literal newline. A bare CR would submit the prompt.
 */
const SHIFT_ENTER = "\x1b\r";

/** Characters a shell never needs quoted; a path made only of these goes raw. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/**
 * A dropped path as Terminal.app types it: single-quoted when it needs it, so
 * `export (3).csv` reaches the shell and an agent's prompt as one argument.
 */
function quotePath(path: string): string {
  if (SHELL_SAFE.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * One terminal on screen: an xterm attached to a session in the pty host.
 *
 * - The view is disposable; the session is not. Unmounting (another tab,
 *   another project, a hidden panel, a reload) detaches and nothing else. The
 *   shell keeps running in the host, and the next mount is drawn from its
 *   snapshot (FE-19/D3).
 * - NOTE: xterm is imported lazily, inside the effect. It touches `window`
 *   when it loads, and the production build prerenders the app shell with no
 *   window.
 * - NOTE: Fitted before attaching. The host resizes to the geometry attach
 *   carries and only then serializes; a snapshot taken at another width
 *   replays wrapped wrong, and a TUI comes back as garbage.
 */
export function XtermPane({
  session,
  onExit,
  onOutput,
}: {
  session: TerminalSession;
  /**
   * Who is told the shell exited. The panel's store by default; an agent's
   * view keeps its sessions in a store of its own.
   */
  onExit?: (project: string, id: string, code: number) => void;
  /**
   * Told when the screen has something on it: a snapshot with content, or
   * live output. An agent's view keeps its spinner up until then.
   */
  onOutput?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminalExited = useTerminal((state) => state.markExited);
  const markExited = onExit ?? terminalExited;
  // The latest callback, without restarting the pane when it changes.
  const outputRef = useRef(onOutput);
  outputRef.current = onOutput;

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
      // Loaded before xterm measures its cell: a family still loading is
      // measured as the fallback, and every row is laid out that wide.
      const code = usePreferences.getState().fonts.code;
      await document.fonts
        .load(`12.5px ${fontStack("code", code)}`)
        .catch(() => undefined);
      if (disposed) return;
      const term = new Terminal({
        fontFamily: fontStack("code", code),
        fontWeight: code?.weight ?? 400,
        fontSize: 12.5,
        lineHeight: 1.2,
        cursorStyle: "bar",
        cursorBlink: !reduced,
        scrollback: TERMINAL_LIMITS.scrollback,
        theme: readTerminalColors(),
        // ⌥ as Meta, the way Terminal.app's "Use Option as Meta key" does:
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
            if (data) outputRef.current?.();
          },
          onData: (data) => {
            term.write(data);
            if (data) outputRef.current?.();
          },
          onExit: (code) => markExited(session.project, session.id, code),
        }),
      );

      const typing = term.onData((data) => surface.input(session.id, data));
      cleanup.push(() => typing.dispose());

      // NOTE: Return false for every event of a ⇧↩ (keydown and keypress), or
      // xterm still sends its own CR from the one let through.
      term.attachCustomKeyEventHandler((event) => {
        const shiftEnter =
          event.key === "Enter" &&
          event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey;
        if (!shiftEnter) return true;
        if (event.type === "keydown") surface.input(session.id, SHIFT_ENTER);
        return false;
      });

      // Files dragged in from Finder are typed as their paths, the way a
      // terminal does it: what Claude Code and Codex take as an attachment.
      const onDragOver = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      };
      const onDrop = (event: DragEvent) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        const paths = files
          .map((file) => surface.pathForFile(file))
          .filter(Boolean)
          .map(quotePath);
        if (paths.length === 0) return;
        surface.input(session.id, `${paths.join(" ")} `);
        term.focus();
      };
      element.addEventListener("dragover", onDragOver);
      element.addEventListener("drop", onDrop);
      cleanup.push(() => {
        element.removeEventListener("dragover", onDragOver);
        element.removeEventListener("drop", onDrop);
      });

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

      // The code font picked in Settings, applied to a terminal already open
      // (FE-21/D5). The cell size changes with it, so it is refitted, and the
      // shell told, the way a drag would.
      cleanup.push(
        usePreferences.subscribe((state, previous) => {
          const next = state.fonts.code;
          if (next === previous.fonts.code) return;
          const family = fontStack("code", next);
          void document.fonts
            .load(`12.5px ${family}`)
            .catch(() => undefined)
            .then(() => {
              if (disposed) return;
              term.options.fontFamily = family;
              term.options.fontWeight = next?.weight ?? 400;
              try {
                fit.fit();
              } catch {
                // Hidden right now; the observer fits it when it shows.
              }
            });
        }),
      );

      term.focus();
    })();

    return () => {
      disposed = true;
      for (const undo of cleanup.reverse()) undo();
    };
  }, [session.id, session.project, markExited]);

  // NOTE: The padding is on the wrapper. FitAddon measures the element xterm
  // was opened in, and padding on that element would count as room for text:
  // the last row and column would render under the edge.
  return (
    <div className="h-full min-h-0 px-3 pt-1.5 pb-1">
      <div ref={host} className="h-full w-full min-h-0 overflow-hidden" />
    </div>
  );
}
