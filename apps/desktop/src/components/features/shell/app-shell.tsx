import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { buttonVariants } from "#/components/ui/button";
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="app-header flex h-14 items-center justify-between border-b">
        <Link to="/" className="flex items-center font-semibold tracking-tight">
          lanework
        </Link>
        <nav aria-label="Main navigation" className="flex gap-2">
          <Link
            to="/"
            className={buttonVariants({ variant: "ghost" })}
            activeProps={{ "aria-current": "page" }}
          >
            Overview
          </Link>
          <Link
            to="/settings"
            className={buttonVariants({ variant: "ghost" })}
            activeProps={{ "aria-current": "page" }}
          >
            Settings
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-10 py-14">{children}</main>
    </div>
  );
}
