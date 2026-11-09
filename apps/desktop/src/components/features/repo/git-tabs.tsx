import { Link, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { type GitTab, useGitView } from "#/stores/git-view";

const TAB =
  "text-muted-foreground hover:text-foreground aria-selected:bg-foreground/[0.08] aria-selected:text-foreground focus-visible:ring-accent-brand flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2";

export const GIT_TAB_ID = (tab: GitTab) => `git-tab-${tab}`;
export const GIT_PANEL_ID = (tab: GitTab) => `git-panel-${tab}`;

/**
 * A callback that shows one tab of the Git view.
 *
 * History opens on the commit last open there (FE-130/D9), so going to
 * Changes and back lands on the same commit.
 */
export function useGitTabNavigate(slug: string) {
  const navigate = useNavigate();
  return useCallback(
    (tab: GitTab) => {
      if (tab === "changes") {
        void navigate({ to: "/w/$slug/changes", params: { slug } });
        return;
      }
      const sha = useGitView.getState().bySlug[slug]?.sha;
      void (sha
        ? navigate({ to: "/w/$slug/history/$sha", params: { slug, sha } })
        : navigate({ to: "/w/$slug/history", params: { slug } }));
    },
    [navigate, slug],
  );
}

/**
 * ⇧⌘1 Changes, ⇧⌘2 History (Ctrl+Shift off macOS), FE-130/D6.
 *
 * Positional like GitHub Desktop's ⌘1/⌘2, which here open projects 1–9.
 * Matched on `event.code`: the shifted digit is "!" on one layout and "1" on
 * another. Left to the terminal while it has focus, where the keys are the
 * shell's.
 */
export function useGitTabKeys(go: (tab: GitTab) => void) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey)
        return;
      const tab =
        event.code === "Digit1"
          ? "changes"
          : event.code === "Digit2"
            ? "history"
            : null;
      if (!tab) return;
      if (event.target instanceof Element && event.target.closest(".xterm"))
        return;
      event.preventDefault();
      go(tab);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
}

/**
 * The Git view's two tabs, in the window's title bar (FE-130/D11).
 *
 * Links, not buttons: each tab is an address (`/changes`, `/history/$sha`),
 * so Back moves between them. An ARIA tablist all the same: one tab stop,
 * ←/→ (and Home/End) move between the two.
 */
export function GitTabs({
  slug,
  tab,
  changed,
  go,
}: {
  slug: string;
  tab: GitTab;
  /** How many files changed, for the Changes tab's badge. */
  changed: number;
  go: (tab: GitTab) => void;
}) {
  const sha = useGitView((state) => state.bySlug[slug]?.sha ?? null);
  const refs = useRef<Record<GitTab, HTMLAnchorElement | null>>({
    changes: null,
    history: null,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: GitTab | null =
      event.key === "ArrowLeft" || event.key === "Home"
        ? "changes"
        : event.key === "ArrowRight" || event.key === "End"
          ? "history"
          : null;
    if (!next) return;
    event.preventDefault();
    if (next !== tab) go(next);
    refs.current[next]?.focus();
  };

  const common = (key: GitTab) => ({
    role: "tab" as const,
    id: GIT_TAB_ID(key),
    "aria-selected": tab === key,
    "aria-controls": GIT_PANEL_ID(key),
    tabIndex: tab === key ? 0 : -1,
    className: TAB,
    ref: (node: HTMLAnchorElement | null) => {
      refs.current[key] = node;
    },
  });

  return (
    <div
      role="tablist"
      aria-label="Commits"
      className="flex shrink-0 items-center gap-1"
      onKeyDown={onKeyDown}
    >
      <Link
        to="/w/$slug/changes"
        params={{ slug }}
        title="Changes (⇧⌘1)"
        {...common("changes")}
      >
        Changes
        {changed > 0 && (
          <span className="bg-foreground/[0.08] text-muted-foreground rounded-full px-1.5 text-[11px] leading-4 tabular-nums">
            {changed}
          </span>
        )}
      </Link>
      {sha ? (
        <Link
          to="/w/$slug/history/$sha"
          params={{ slug, sha }}
          title="History (⇧⌘2)"
          {...common("history")}
        >
          History
        </Link>
      ) : (
        <Link
          to="/w/$slug/history"
          params={{ slug }}
          title="History (⇧⌘2)"
          {...common("history")}
        >
          History
        </Link>
      )}
    </div>
  );
}
