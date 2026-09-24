import {
  GitPullRequestIcon,
  ListViewIcon,
  PencilEdit02Icon,
  Search01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { Kbd } from "#/components/ui/kbd";
import { useBoard } from "#/stores/board";
import { useCommandPalette } from "#/stores/command-palette";
import { useIssueView } from "#/stores/issue-view";
import { usePulls } from "#/stores/pulls";
import { useSession } from "#/stores/session";
import { AccountOrb } from "./account-orb";
import { ProjectSwitcher } from "./project-switcher";

/** One row of the rail. The hover/active language is `settings-nav`'s, on purpose. */
const ROW =
  "group flex h-[30px] items-center gap-2.5 rounded-md px-2 text-[13px] transition-[background-color,scale] duration-150 ease-out [&:not([aria-current])]:hover:bg-foreground/[0.04] active:scale-[0.98]";

const ACTIVE = {
  className: "bg-foreground/[0.08]",
  "aria-current": "page" as const,
};

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-muted-foreground px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide uppercase">
      {children}
    </span>
  );
}

export function AppSidebar() {
  // ⚠️ Read from the URL, not from the store. The rail has to draw correctly on
  // the very first paint of a deep link, before anything has been fetched — and
  // the URL is the only thing that is already true at that moment.
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const view = useBoard((state) => state.view);
  const lastView = useIssueView((state) =>
    slug ? state.bySlug[slug] : undefined,
  );
  const open = useCommandPalette((state) => state.open);
  // Null until the pull-request screen has been opened once — a rail entry
  // that fetched to draw its own badge would read GitHub on every start.
  const pulls = usePulls((state) => state.view);
  const session = useSession((state) => state.session);
  const navigate = useNavigate();

  // ⚠️ ⌘N is free on macOS: Electron's default menu binds ⌘W and ⌘Q, never ⌘N,
  // so nothing native swallows this before the window sees it.
  useEffect(() => {
    if (!slug) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(event.metaKey || event.ctrlKey))
        return;
      event.preventDefault();
      void navigate({ to: "/w/$slug/issues/new", params: { slug } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, slug]);

  // The orb's seed, not a label — see `AccountOrb`. Absent when the control
  // plane never told us who owns this machine, and then there is no mark to
  // draw rather than a mark standing for nobody.
  const accountSeed =
    session?.principal.kind === "machine"
      ? (session.principal.userId ?? "")
      : "";

  return (
    <aside className="app-sidebar flex min-h-0 flex-1 flex-col px-2.5">
      {/* Clears the native traffic lights and gives the window a drag handle. */}
      <div className="app-sidebar-titlebar shrink-0" aria-hidden="true" />
      <ProjectSwitcher />

      {/* ⚠️ Composing sits ABOVE navigating, and the two share one row. The
          rail's first control is the one thing a person came to do; search has
          the whole palette behind it and a shortcut people already know, so it
          gives up its label rather than its place. */}
      <div className="mt-1 mb-1 flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={!slug}
          title={
            slug ? undefined : "Open a project before writing an issue for it."
          }
          onClick={() =>
            slug &&
            void navigate({ to: "/w/$slug/issues/new", params: { slug } })
          }
          className="hover:bg-foreground/[0.06] bg-foreground/[0.035] flex h-[30px] flex-1 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150 disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={PencilEdit02Icon}
            className="text-muted-foreground size-4"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span>New issue</span>
          <Kbd className="ml-auto">⌘N</Kbd>
        </button>
        <button
          type="button"
          onClick={open}
          aria-label="Search"
          title="Search — ⌘K"
          className="hover:bg-foreground/[0.06] bg-foreground/[0.035] flex size-[30px] shrink-0 items-center justify-center rounded-md transition-colors duration-150"
        >
          <HugeiconsIcon
            icon={Search01Icon}
            className="text-muted-foreground size-4"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {slug && (
          <nav aria-label="Project" className="flex flex-col gap-0.5">
            <SectionLabel>Project</SectionLabel>
            <Link
              to="/w/$slug/issues"
              params={{ slug }}
              // ⚠️ The filters are cleared on the way in. "Issues" has to mean
              // every issue; a rail entry that silently kept the last category
              // filter would show a board that is missing work with no visible
              // reason why. The VIEW is kept (FE-13/D5): list or lanes is how
              // you read, not what you are looking for.
              search={lastView === "board" ? { view: "board" } : {}}
              className={ROW}
              activeOptions={{ exact: true, includeSearch: false }}
              activeProps={ACTIVE}
            >
              <HugeiconsIcon
                icon={ListViewIcon}
                className="text-muted-foreground group-[[aria-current]]:text-foreground size-4"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              Issues
              {view && (
                <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                  {view.cards.length}
                </span>
              )}
            </Link>
            <Link
              to="/w/$slug/pulls"
              params={{ slug }}
              search={{ tab: "all", status: "open" }}
              className={ROW}
              activeProps={ACTIVE}
            >
              <HugeiconsIcon
                icon={GitPullRequestIcon}
                className="text-muted-foreground group-[[aria-current]]:text-foreground size-4"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              Pull requests
              {pulls && (
                <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                  {pulls.pulls.length}
                </span>
              )}
            </Link>
          </nav>
        )}
      </div>

      <div className="border-sidebar-border mt-2 shrink-0 border-t pt-2 pb-2.5">
        <Link to="/settings" className={ROW}>
          <HugeiconsIcon
            icon={Settings01Icon}
            className="text-muted-foreground size-4"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          Settings
          {accountSeed && (
            // ⚠️ Hidden from the accessible name. A mark appended to "Settings"
            // tells a screen-reader user nothing and makes the link impossible
            // to address by the word on it.
            <AccountOrb seed={accountSeed} className="ml-auto size-5" />
          )}
        </Link>
      </div>
    </aside>
  );
}
