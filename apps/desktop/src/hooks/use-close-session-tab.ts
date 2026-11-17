import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { useSessionTabs } from "#/stores/session-tabs";

/**
 * Closes a session's tab in `slug` (FE-144), the way the tab's ×, its `…`
 * menu and ⌘W all do. Closing the tab on screen opens its neighbour, or a
 * new chat when it was the last; closing another one leaves the page alone.
 */
export function useCloseSessionTab(slug: string | undefined) {
  const navigate = useNavigate();
  const close = useSessionTabs((state) => state.close);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return useCallback(
    (id: string) => {
      if (!slug) return;
      const next = close(slug, id);
      const shown = pathname.endsWith(`/agents/chat/${encodeURIComponent(id)}`);
      if (!shown) return;
      if (next)
        void navigate({
          to: "/w/$slug/agents/chat/$conversation",
          params: { slug, conversation: next },
        });
      else void navigate({ to: "/w/$slug/agents/chat/new", params: { slug } });
    },
    [slug, close, navigate, pathname],
  );
}
