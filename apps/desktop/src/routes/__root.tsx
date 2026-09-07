import {
  ClientOnly,
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { AppShell } from "#/components/features/shell/app-shell";
import css from "#/styles/app.css?url";
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Lanework" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  shellComponent: Document,
  component: () => (
    <ClientOnly fallback={<p className="p-8">Opening Lanework…</p>}>
      <AppShell>
        <Outlet />
      </AppShell>
    </ClientOnly>
  ),
});
function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
        <Scripts />
      </body>
    </html>
  );
}
