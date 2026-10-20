import {
  ClientOnly,
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { AuthGate } from "#/components/features/auth/auth-gate";
import { StartupLoading } from "#/components/shared/loading/startup-loading";
import { useFonts } from "#/hooks/use-fonts";
import { useNotificationRouting } from "#/hooks/use-notification-routing";
import { useTheme } from "#/hooks/use-theme";
import { useVibrancy } from "#/hooks/use-vibrancy";
import { usePreferences } from "#/stores/preferences";
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
  component: RootShell,
});
function RootShell() {
  useVibrancy();
  useTheme();
  useFonts();
  useNotificationRouting();
  // Hydrated once for the whole app. It used to live in `AppShell`, which left
  // a route outside that shell reading the store's defaults rather than the
  // user's saved preference.
  useEffect(() => {
    void usePreferences.persist.rehydrate();
  }, []);
  return (
    <ClientOnly fallback={<StartupLoading />}>
      <AuthGate>
        <Outlet />
      </AuthGate>
    </ClientOnly>
  );
}
function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen text-foreground antialiased">
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
        <Scripts />
      </body>
    </html>
  );
}
