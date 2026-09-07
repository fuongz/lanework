import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { usePreferences } from "#/stores/preferences";
export function AppShell({ children }: { children: ReactNode }) {
  const compact = usePreferences((state) => state.compact);
  useEffect(() => {
    void usePreferences.persist.rehydrate();
  }, []);
  useEffect(() => {
    let disposed = false;
    void window.desktop
      ?.getAppInfo()
      .then((info) => {
        if (!disposed && info.platform === "darwin")
          document.documentElement.dataset.vibrancy = "true";
      })
      .catch(() => {
        // Keep the opaque fallback when native app information is unavailable.
      });
    return () => {
      disposed = true;
      delete document.documentElement.dataset.vibrancy;
    };
  }, []);
  return (
    <div className="min-h-screen">
      <header className="flex h-20 items-center justify-between border-b px-8">
        <Link
          to="/"
          className="flex items-center gap-3 font-semibold tracking-tight"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            L
          </span>
          lanework<Badge variant="outline">Desktop</Badge>
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
      <main
        data-compact={compact}
        className={cn(
          "mx-auto max-w-5xl",
          compact ? "px-6 py-8" : "px-10 py-14",
        )}
      >
        {children}
      </main>
    </div>
  );
}
