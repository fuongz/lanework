import {
  Add01Icon,
  Grid2X2Icon,
  ListViewIcon,
  Settings01Icon,
  Sun01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusIcon } from "#/components/shared/board/glyphs";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { columnOf } from "#/lib/board-view";
import { useBoard } from "#/stores/board";
import { useCommandPalette } from "#/stores/command-palette";
import { usePreferences } from "#/stores/preferences";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: typeof Sun01Icon;
  /** Rendered instead of `icon` when a card's own lane glyph is the right cue. */
  lane?: string;
  run: () => void;
}

/**
 * ⌘K.
 *
 * ⚠️ Cards are matched from the board already in memory rather than through
 * `lookup`. The board read pages until the cursor runs out, so the list is
 * complete — and a keystroke-per-request palette would be slower and wrong the
 * moment the network hiccups. `lookup` earns its keep on the detail route,
 * where a deep link can name a card no list has been read for.
 */
export function CommandPalette() {
  const isOpen = useCommandPalette((state) => state.isOpen);
  const close = useCommandPalette((state) => state.close);
  const toggle = useCommandPalette((state) => state.toggle);
  const view = useBoard((state) => state.view);
  const workspaces = useBoard((state) => state.workspaces);
  const setTheme = usePreferences((state) => state.setTheme);
  const theme = usePreferences((state) => state.theme);
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // A palette that reopened on yesterday's query would be a palette nobody
  // trusts to be showing them everything.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setAt(0);
    }
  }, [isOpen]);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    if (slug) {
      for (const card of view?.cards ?? [])
        out.push({
          id: `card:${card.id}`,
          label: card.title,
          hint: card.taskId ?? undefined,
          lane: card.columnKey,
          run: () => {
            if (!card.taskId) return;
            void navigate({
              to: "/w/$slug/issues/$taskId",
              params: { slug, taskId: card.taskId },
            });
          },
        });
      out.push(
        {
          id: "nav:issues",
          label: "Go to issues",
          icon: ListViewIcon,
          run: () =>
            void navigate({
              to: "/w/$slug/issues",
              params: { slug },
              search: {},
            }),
        },
        {
          id: "nav:board",
          label: "Go to board",
          icon: Grid2X2Icon,
          run: () =>
            void navigate({
              to: "/w/$slug/board",
              params: { slug },
              search: {},
            }),
        },
        {
          id: "card:new",
          label: "New issue",
          hint: "⌘N",
          icon: Add01Icon,
          // It used to land on the issues LIST, which is a page with a
          // one-line add field on it — not a place to write an issue.
          run: () =>
            void navigate({ to: "/w/$slug/issues/new", params: { slug } }),
        },
      );
    }
    for (const workspace of workspaces)
      out.push({
        id: `project:${workspace.slug}`,
        label: `Open ${workspace.name}`,
        hint: "Project",
        icon: Grid2X2Icon,
        run: () =>
          void navigate({
            to: "/w/$slug/issues",
            params: { slug: workspace.slug },
            search: {},
          }),
      });
    out.push(
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light" : "Switch to dark",
        icon: Sun01Icon,
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "settings",
        label: "Open settings",
        icon: Settings01Icon,
        run: () => void navigate({ to: "/settings" }),
      },
    );
    return out;
  }, [navigate, setTheme, slug, theme, view, workspaces]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? commands.filter((command) =>
        `${command.hint ?? ""} ${command.label}`.toLowerCase().includes(needle),
      )
    : commands.slice(0, 12);
  const cursor = Math.min(at, Math.max(0, matches.length - 1));

  const pick = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-lg translate-y-0 gap-0 p-0"
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <input
          // A palette that opens without the caret in its field needs a second
          // keystroke to do the one thing it exists for.
          autoFocus
          aria-label="Search and commands"
          aria-controls="command-palette-list"
          aria-activedescendant={matches[cursor]?.id}
          placeholder="Jump to a card, a project, or a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setAt(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setAt((value) => Math.min(value + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setAt((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(matches[cursor]);
            }
          }}
          className="border-border h-11 w-full border-b bg-transparent px-4 text-[13px] outline-none"
        />
        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="flex max-h-80 flex-col overflow-y-auto p-1.5"
        >
          {matches.length === 0 && (
            <p className="text-muted-foreground px-2.5 py-6 text-center text-[13px]">
              Nothing matches “{query.trim()}”.
            </p>
          )}
          {matches.map((command, index) => (
            <button
              key={command.id}
              id={command.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              onMouseEnter={() => setAt(index)}
              onClick={() => pick(command)}
              className="aria-selected:bg-foreground/[0.06] flex h-[34px] shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px]"
            >
              {command.lane ? (
                <StatusIcon
                  column={columnOf(view?.columns ?? [], command.lane)}
                />
              ) : (
                command.icon && (
                  <HugeiconsIcon
                    icon={command.icon}
                    className="text-muted-foreground size-4 shrink-0"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                )
              )}
              {command.hint && (
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {command.hint}
                </span>
              )}
              <span className="truncate">{command.label}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
