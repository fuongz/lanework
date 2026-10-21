import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * The window's half of OS notifications (FE-70): tell main which path is on
 * screen, so a focused window is not told what it already shows (D2a), and go
 * where a clicked notification points (D5).
 *
 * ⚠️ At the root, not in `AppShell`: Settings is outside that shell, and a
 * click from there must still open the conversation or pull request.
 */
export function useNotificationRouting(): void {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    window.desktop?.notifications.reportLocation(path);
  }, [path]);

  useEffect(
    () =>
      window.desktop?.notifications.onOpen((target) => {
        if (target.kind === "session")
          void navigate({
            to: "/w/$slug/agents/chat/$conversation",
            params: { slug: target.slug, conversation: target.conversation },
          });
        else
          void navigate({
            to: "/w/$slug/issues/pulls/$number",
            params: { slug: target.slug, number: String(target.number) },
            search: { tab: "all", status: "open" },
          });
      }),
    [navigate],
  );
}
