import { ArrowLeft02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Input } from "#/components/ui/input";
import { useSettingsSearch } from "#/stores/settings-search";
import { SettingsNav } from "./settings-nav";

/**
 * The full-window settings view: a sidebar of sections beside the open one.
 *
 * ⚠️ Deliberately outside `AppShell`. Settings replaces the whole window rather
 * than sitting inside the app's chrome, so it carries its own way back — the
 * app's nav would otherwise offer two competing places to click.
 *
 * The sidebar's background lives in CSS (`.settings-sidebar`) rather than in a
 * utility class, because on macOS it has to become fully transparent so the
 * window's vibrancy shows through, and that depends on an ancestor attribute.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const query = useSettingsSearch((state) => state.query);
  const setQuery = useSettingsSearch((state) => state.setQuery);
  // Config files and Skills are a tree beside an editor (FE-47/D8): they
  // take the whole pane and draw their own headers, not a column of rows.
  const wide = useRouterState({
    select: (state) =>
      state.location.pathname === "/settings/config" ||
      state.location.pathname === "/settings/skills",
  });

  return (
    <div className="flex h-screen">
      <aside className="settings-sidebar flex w-60 shrink-0 flex-col overflow-y-auto px-2.5">
        {/* Clears the native traffic lights and gives the window a drag handle,
            which the app header would otherwise have provided. */}
        <div className="settings-titlebar shrink-0" aria-hidden="true" />
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
            // `md:` too: the base Input drops to `text-xs` at that breakpoint,
            // which would undo this everywhere the window is wider than 768px.
            // `border-0` rather than a transparent border: the base
            // Input's `border-input` wins the colour, and a transparent
            // border still leaves a 1px gap under `bg-clip-padding`.
            className="bg-foreground/[0.035] h-[30px] rounded-md border-0 pl-7.5 text-[13px] md:text-[13px]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <SettingsNav />
      </aside>
      {wide ? (
        <div className="bg-background min-w-0 flex-1">{children}</div>
      ) : (
        <div className="bg-background flex-1 overflow-y-auto">
          <div className="settings-titlebar" aria-hidden="true" />
          <div className="mx-auto max-w-3xl px-10 pt-8 pb-20">{children}</div>
        </div>
      )}
    </div>
  );
}
