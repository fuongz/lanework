import { ArrowLeft02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { WindowTitlebarHost } from "#/components/shared/navigation/window-titlebar";
import { Input } from "#/components/ui/input";
import { useSettingsSearch } from "#/stores/settings-search";
import { SettingsNav } from "./settings-nav";
import { SettingsProjectPicker } from "./settings-project-picker";

const WIDE =
  /^\/settings\/(config|skills|project-skills|memory|instructions)(\/|$)/;

/**
 * The full-window settings view: a sidebar of sections beside the open one.
 *
 * Outside `AppShell`. Settings replaces the whole window rather than sitting
 * inside the app's chrome, so it carries its own way back; the app's nav
 * would offer a second, competing one.
 *
 * The sidebar's background lives in CSS (`.settings-sidebar`), not a utility
 * class. On macOS it turns fully transparent so the window's vibrancy shows
 * through, and that depends on an ancestor attribute.
 */
const CARD =
  "bg-background border-panel-edge my-1.5 mr-1.5 flex-1 rounded-lg border";

export function SettingsShell({ children }: { children: ReactNode }) {
  const query = useSettingsSearch((state) => state.query);
  const setQuery = useSettingsSearch((state) => state.setQuery);
  // Config files and Skills are a tree beside an editor (FE-47/D8); Memory
  // and Instructions are a list beside the open file. They take the whole
  // pane and draw their own headers, not a column of rows.
  const wide = useRouterState({
    select: (state) => WIDE.test(state.location.pathname),
  });

  return (
    // The same window as the app shell: a title bar across it, and under it
    // the rail beside an inset card. Most pages keep their title in their own
    // content. The file pages (Skills, Config files) put theirs in the bar as
    // Files does, and the Projects pages their project picker.
    //
    // NOTE: The split is stated, not read from `--rail-width`. That variable
    // is the app rail's, and it stays on <html> at whatever width the rail had
    // when the app shell went away.
    <div className="bg-sidebar flex h-screen flex-col">
      <WindowTitlebarHost
        style={{ "--titlebar-split": "15rem" } as CSSProperties}
        // On every page, not only the Projects ones: which project the
        // Projects pages are about is worth seeing from anywhere here.
        lead={<SettingsProjectPicker />}
      />
      <div className="flex min-h-0 flex-1">
        <aside className="settings-sidebar flex w-60 shrink-0 flex-col overflow-y-auto px-2.5">
          <Link
            to="/"
            className="hover:bg-foreground/[0.04] mt-2 flex h-[30px] shrink-0 items-center gap-2.5 rounded-md px-2 text-[13px] transition-[background-color,scale] duration-150 ease-out active:scale-[0.98]"
          >
            <HugeiconsIcon
              icon={ArrowLeft02Icon}
              className="size-4"
              strokeWidth={1.5}
            />
            Back to app
          </Link>
          <div className="relative mt-1 mb-1 shrink-0">
            <HugeiconsIcon
              icon={Search01Icon}
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2"
              strokeWidth={1.5}
            />
            <Input
              aria-label="Search settings"
              placeholder="Search settings…"
              // - `md:` too: the base Input drops to `text-xs` at that
              //   breakpoint, which would undo this in any window wider than
              //   768px.
              // - `border-0`, not a transparent border: the base Input's
              //   `border-input` wins the colour, and a transparent border
              //   still leaves a 1px gap under `bg-clip-padding`.
              className="bg-foreground/[0.035] h-[30px] rounded-md border-0 pl-7.5 text-[13px] md:text-[13px]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <SettingsNav />
        </aside>
        {wide ? (
          <div className={`${CARD} min-w-0 overflow-hidden`}>{children}</div>
        ) : (
          <div className={`${CARD} overflow-y-auto`}>
            <div className="mx-auto max-w-3xl px-10 pt-8 pb-20">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}
