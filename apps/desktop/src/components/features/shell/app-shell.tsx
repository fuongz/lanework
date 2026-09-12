import { Outlet } from "@tanstack/react-router";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";

/**
 * The window: a rail that never moves, and one scrolling pane beside it.
 *
 * ⚠️ Only the pane scrolls. A shell that scrolls as a whole takes the project
 * switcher and the lane list off screen the moment a board is long, which is
 * the one thing a persistent sidebar exists to prevent.
 */
export function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden">
      <AppSidebar />
      <main className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
      <CommandPalette />
    </div>
  );
}
