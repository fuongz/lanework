// The open text file of Repository › Files, editable through Pierre's edit
// mode. Loaded on demand (`file-view.tsx` imports it lazily), so the editor
// code (`@pierre/diffs/edit`) is fetched the first time a text file opens.
//
// `CodeView` with one `file` item rather than `File`: it virtualizes, so a
// two-megabyte file draws the lines on screen, not forty thousand of them,
// and it is the same renderer (theme, highlighter, font) the diffs use.
import type { CodeViewItem } from "@pierre/diffs";
import {
  Editor,
  type EditorFactory,
  type EditorOptions,
  type EditorType,
  EditStateManager,
} from "@pierre/diffs/edit";
import {
  CodeView,
  type CodeViewHandle,
  EditProvider,
} from "@pierre/diffs/react";
import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDark } from "#/hooks/use-dark";
import { useFiles } from "#/stores/files";

/** Every editor of this screen is a plain Pierre editor, keyed by the caller. */
const createEditor: EditorFactory<undefined, undefined> = (
  type,
  options,
  editStateKey,
) => new Editor(type, options, editStateKey);

/**
 * Shared by every file: the defaults are what is wanted (find/replace,
 * multi-cursor, bracket matching, auto-surround, move line, comments).
 *
 * NOTE: No `clipboard` provider. Pierre's own needs `readText`, and this
 * window refuses `clipboard-read` (`electron/main/index.ts`) and has no
 * preload clipboard, so `navigator.clipboard.readText()` would reject and
 * break ⌘V. Without the option ⌘V goes through the native `paste` event,
 * which Electron's Edit menu fires and which carries Pierre's
 * multi-selection data too.
 */
const EDITOR_OPTIONS: Omit<
  EditorOptions<EditorType, undefined, undefined>,
  "onChange"
> = {
  matchBrackets: true,
  autoSurround: "default",
};

export function FileEditor({
  editKey,
  path,
}: {
  /** The retained draft's key: project, folder and path. */
  editKey: string;
  path: string;
}) {
  const dark = useDark();
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);
  const revealAt = useFiles((state) => state.revealAt);
  const clearReveal = useFiles((state) => state.clearReveal);
  const edit = useFiles((state) => state.edit);
  const revision = useFiles((state) => state.buffers[path]?.revision ?? 0);

  // The text pushed into the editor: the buffer's at mount and whenever the
  // store replaced it (`revision`), never what was typed (that would loop).
  const input = useRef<{ revision: number; text: string } | null>(null);
  if (input.current === null || input.current.revision !== revision) {
    const text = useFiles.getState().buffers[path]?.text ?? "";
    // A draft Pierre still retains for this key from before (the tab was
    // closed, or the edits dropped) would come back over the store's text:
    // drop it, so the buffer is the one truth.
    if (input.current === null) {
      const retained = EditStateManager.get("file", editKey);
      if (retained && retained.document.getText() !== text)
        EditStateManager.clear("file", editKey);
    }
    input.current = { revision, text };
  }
  const text = input.current.text;

  const options = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: dark ? ("dark" as const) : ("light" as const),
      overflow: "scroll" as const,
      // The pane's ground (`--editor` in app.css), not pierre-dark's near
      // black. The unsafe layer comes after the theme's, and the active
      // line is mixed from this, so it follows.
      //
      // `[data-code]` keeps scrolling sideways, but its own bar is hidden:
      // `SidewaysBar` below draws one at the pane's foot (see there).
      unsafeCSS: `:host { --diffs-dark-bg: var(--editor); --diffs-light-bg: var(--editor); }
        [data-code] { scrollbar-width: none; }
        [data-code]::-webkit-scrollbar { display: none; }`,
      // The header above is this screen's own; the library's would repeat it.
      disableFileHeader: true,
      // NOTE: The JS highlighter. The window's CSP blocks the wasm one (see
      // `patch-view.tsx`).
      preferredHighlighter: "shiki-js" as const,
      // A minified bundle is one enormous line; past these it is drawn plain
      // rather than tokenised for seconds.
      tokenizeMaxLineLength: 2_000,
      tokenizeMaxLength: 400_000,
      layout: { paddingTop: 4, paddingBottom: 8, gap: 0 },
    }),
    [dark],
  );

  // NOTE: `cacheKey` moves with `revision`. Pierre compares the file it is
  // given by it, so a revert to the text it was first given still reaches
  // the editor as a new document; `version` tells CodeView the item moved.
  const items = useMemo<CodeViewItem<undefined>[]>(
    () => [
      {
        id: path,
        type: "file",
        file: {
          name: path,
          contents: text,
          cacheKey: `${editKey}@${revision}`,
        },
        version: revision,
        edit: true,
      },
    ],
    [path, text, editKey, revision],
  );

  // A ⌘⇧F result asked for a line (FE-149): scroll there and put the caret
  // on it, once. A frame later, so CodeView has laid out the text it just got.
  useEffect(() => {
    if (!revealAt || revealAt.path !== path) return;
    const frame = requestAnimationFrame(() => {
      const line = revealAt.line;
      view.current?.scrollTo({
        type: "line",
        id: path,
        lineNumber: line,
        align: "center",
      });
      const editor = view.current?.getEditor(path);
      if (editor) editor.focus({ lineNumber: line, preventScroll: true });
      else
        view.current?.setSelectedLines({
          id: path,
          range: { start: line, end: line },
        });
      clearReveal();
    });
    return () => cancelAnimationFrame(frame);
  }, [revealAt, path, clearReveal]);

  const getEditStateKey = useCallback(() => editKey, [editKey]);
  const onItemEditChange = useCallback(
    (event: { file: { contents: string } }) => edit(path, event.file.contents),
    [edit, path],
  );
  const onItemEditComplete = useCallback(() => "accept" as const, []);

  const pane = useRef<HTMLDivElement>(null);

  return (
    <EditProvider createEditor={createEditor}>
      <div ref={pane} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <CodeView
          ref={view}
          items={items}
          options={options}
          editorOptions={EDITOR_OPTIONS}
          getEditStateKey={getEditStateKey}
          onItemEditChange={onItemEditChange}
          // The buffer already has every change; what the editor ends with on
          // unmount is retained under `editKey`, not installed anywhere.
          onItemEditComplete={onItemEditComplete}
          // The scroller CodeView virtualizes against — see `patch-view.tsx`.
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        />
        <SidewaysBar pane={pane} />
      </div>
    </EditProvider>
  );
}

/** The file's `[data-code]`, inside the shadow root CodeView draws it in. */
function codeIn(pane: HTMLElement): HTMLElement | null {
  for (const element of pane.querySelectorAll("*")) {
    const code = element.shadowRoot?.querySelector<HTMLElement>("[data-code]");
    if (code) return code;
  }
  return null;
}

/**
 * The sideways scrollbar, at the pane's foot.
 *
 * Pierre scrolls each file's `[data-code]` sideways by itself, so its bar
 * sits under the file's last line: mid-pane on a short file, out of sight
 * on a long one until its end. That bar is hidden and this one, a plain
 * scroller as wide as the code, mirrors it both ways, as an editor's does.
 *
 * NOTE: Re-read on scroll, wheel, typing and resize rather than observed.
 * The code lives in a shadow root and its lines are virtualized, so the
 * element and its width change as the file scrolls or is edited.
 */
function SidewaysBar({
  pane,
}: {
  pane: React.RefObject<HTMLDivElement | null>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const root = pane.current;
    const track = bar.current;
    if (!root || !track) return;
    let code: HTMLElement | null = null;
    let frame = 0;
    let retry = 0;
    let tries = 0;
    // The side that moved last; the other follows without echoing back.
    let syncing = false;

    const fromCode = () => {
      if (!code || syncing) return;
      syncing = true;
      track.scrollLeft = code.scrollLeft;
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
    const measure = () => {
      frame = 0;
      const next = codeIn(root);
      if (next !== code) {
        if (code) {
          code.removeEventListener("scroll", fromCode);
          resize.unobserve(code);
        }
        code = next;
        if (code) {
          code.addEventListener("scroll", fromCode, { passive: true });
          resize.observe(code);
        }
      }
      // The editor entry loads lazily and CodeView lays out a frame later:
      // nothing fires when the code first appears, so look again shortly.
      if (!code || code.scrollWidth === 0) {
        if (tries++ < 40) retry = window.setTimeout(schedule, 150);
        return setVisible(false);
      }
      tries = 0;
      // The code is narrower than this bar by the pane's vertical
      // scrollbar; widen the track by as much so both ranges are equal.
      setWidth(code.scrollWidth + track.clientWidth - code.clientWidth);
      setVisible(code.scrollWidth > code.clientWidth + 1);
      track.scrollLeft = code.scrollLeft;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // A sideways wheel outside the lines (under a short file's last line,
    // over the bar) would scroll nothing: `[data-code]` takes it only over
    // itself. Hand it the delta there; over the code the browser does it.
    const sideways = (event: WheelEvent) => {
      schedule();
      if (!code || event.composedPath().includes(code)) return;
      // Shift+wheel on a mouse: its vertical delta is the sideways one.
      const shifted = event.shiftKey && event.deltaX === 0;
      const delta = shifted ? event.deltaY : event.deltaX;
      // A mostly vertical trackpad swipe stays the pane's own scroll.
      if (delta === 0 || (!shifted && Math.abs(delta) < Math.abs(event.deltaY)))
        return;
      const step = event.deltaMode === 1 ? delta * 16 : delta;
      code.scrollLeft += step;
      event.preventDefault();
    };
    const fromBar = () => {
      if (!code || syncing) return;
      syncing = true;
      code.scrollLeft = track.scrollLeft;
      requestAnimationFrame(() => {
        syncing = false;
      });
    };

    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    schedule();
    // Capture: scroll does not bubble, and the code's events come retargeted
    // out of its shadow root.
    root.addEventListener("scroll", schedule, { capture: true, passive: true });
    // Not passive: a sideways wheel outside the code is taken over.
    root.addEventListener("wheel", sideways, { capture: true, passive: false });
    root.addEventListener("input", schedule, true);
    root.addEventListener("keyup", schedule, true);
    track.addEventListener("scroll", fromBar, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      resize.disconnect();
      root.removeEventListener("scroll", schedule, true);
      root.removeEventListener("wheel", sideways, true);
      root.removeEventListener("input", schedule, true);
      root.removeEventListener("keyup", schedule, true);
      track.removeEventListener("scroll", fromBar);
      code?.removeEventListener("scroll", fromCode);
    };
  }, [pane]);

  return (
    <div
      ref={bar}
      aria-hidden="true"
      className={cn(
        "shrink-0 overflow-x-auto overflow-y-hidden",
        !visible && "hidden",
      )}
    >
      <div className="h-px" style={{ width }} />
    </div>
  );
}
