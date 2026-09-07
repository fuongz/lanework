import { ArrowLeft02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
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

  return (
    <div className="flex h-screen">
      <aside className="settings-sidebar flex w-[272px] shrink-0 flex-col overflow-y-auto px-3">
        {/* Clears the native traffic lights and gives the window a drag handle,
            which the app header would otherwise have provided. */}
        <div className="settings-titlebar shrink-0" aria-hidden="true" />
        <Link
          to="/"
          className="hover:bg-foreground/[0.04] mt-3 flex h-[34px] shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-[background-color,scale] duration-150 ease-out active:scale-[0.96]"
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            className="size-4"
            strokeWidth={1.5}
          />
          Back to app
        </Link>
        <div className="relative my-2 shrink-0">
          <HugeiconsIcon
            icon={Search01Icon}
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
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
            className="bg-foreground/[0.05] h-8 rounded-lg border-0 pl-8 text-sm md:text-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <SettingsNav />
      </aside>
      <div className="bg-background flex-1 overflow-y-auto">
        <div className="settings-titlebar" aria-hidden="true" />
        <div className="mx-auto max-w-3xl px-10 pt-8 pb-20">{children}</div>
      </div>
    </div>
  );
}
