import {
  Add01Icon,
  Grid2X2Icon,
  ListViewIcon,
  Search01Icon,
  Settings01Icon,
  Sun01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type BoardCard, matchesSearch } from "#/../shared/projects";
import { listedProjects } from "#/components/shared/auth/local-mode";
import { StatusIcon } from "#/components/shared/board/glyphs";
import { RAIL_SPRING } from "#/components/shared/navigation/rail-hover";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { Kbd, KbdGroup } from "#/components/ui/kbd";
import { columnOf } from "#/lib/board-view";
import { useBoard } from "#/stores/board";
import { useCommandPalette } from "#/stores/command-palette";
import { useOpenProject } from "#/stores/last-route";
import { usePreferences } from "#/stores/preferences";

/** The palette's sections, in the order they are drawn. */
const GROUPS = ["Issues", "This project", "Projects", "App"] as const;
type Group = (typeof GROUPS)[number];

interface Command {
  id: string;
  label: string;
  /** The section it is listed under. */
  group: Group;
  /** A line under the label: what it does or where it goes. */
  detail?: string;
  /** A card's task id, on the right of its row. */
  hint?: string;
  /** Its keyboard shortcut, one key per entry, drawn as keycaps. */
  keys?: string[];
  icon?: typeof Sun01Icon;
  /** Drawn instead of `icon` when a card's own lane glyph is the right cue. */
  lane?: string;
  run: () => void;
}

/** How long typing has to pause before the service is asked (FE-18/D4). */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The ⌘K palette: commands, and cards by title or task id.
 *
 * Cards are searched on the service once two characters are typed. The board
 * is read one page per group, so the cards in memory are a fraction of it,
 * and a search over them alone would miss the old ones: the ones you open a
 * palette to find. The loaded matches still show at once, so the palette
 * never waits on the network for something it already knows, and they are
 * what is left when the service cannot be asked.
 */
export function CommandPalette() {
  const isOpen = useCommandPalette((state) => state.isOpen);
  const close = useCommandPalette((state) => state.close);
  const toggle = useCommandPalette((state) => state.toggle);
  const view = useBoard((state) => state.view);
  const projects = useBoard((state) => state.projects);
  const setTheme = usePreferences((state) => state.setTheme);
  const theme = usePreferences((state) => state.theme);
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const navigate = useNavigate();
  const openProject = useOpenProject();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const projectId = useBoard((state) => state.active?.id ?? null);
  /** The service's answer, for the query it answered; never a stale one. */
  const [remote, setRemote] = useState<{
    query: string;
    cards: BoardCard[] | null;
  } | null>(null);
  const trimmed = query.trim();
  const searching = Boolean(slug && projectId) && trimmed.length >= 2;

  // One request per pause, not per keystroke, and an answer counts only for
  // the query it was asked for: typing on drops whatever was in flight.
  useEffect(() => {
    if (!isOpen || !searching || !projectId) return;
    let live = true;
    const timer = setTimeout(() => {
      const surface = window.desktop?.projects;
      if (!surface) return;
      surface.board
        .search(projectId, trimmed)
        .then((cards) => live && setRemote({ query: trimmed, cards }))
        .catch(() => live && setRemote({ query: trimmed, cards: null }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [isOpen, searching, trimmed, projectId]);
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
      out.push(
        {
          id: "nav:issues",
          label: "Go to issues",
          group: "This project",
          detail: "This project's board",
          icon: ListViewIcon,
          run: () =>
            void navigate({
              to: "/w/$slug/issues",
              params: { slug },
              search: {},
            }),
        },
        {
          id: "card:new",
          label: "New issue",
          group: "This project",
          detail: "Write a new card",
          keys: ["⌘", "N"],
          icon: Add01Icon,
          // The composer, not the issues list: a one-line add field is not a
          // place to write an issue.
          run: () =>
            void navigate({ to: "/w/$slug/issues/new", params: { slug } }),
        },
      );
    }
    for (const project of listedProjects(projects, projectId))
      out.push({
        id: `project:${project.slug}`,
        label: project.name,
        group: "Projects",
        detail: "Switch to this project",
        icon: Grid2X2Icon,
        run: () => openProject(project.slug),
      });
    out.push(
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light" : "Switch to dark",
        group: "App",
        detail: "Change the theme of the app",
        icon: Sun01Icon,
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "settings",
        label: "Open settings",
        group: "App",
        detail: "Accounts, agents, appearance and more",
        icon: Settings01Icon,
        run: () => void navigate({ to: "/settings" }),
      },
    );
    return out;
  }, [navigate, openProject, setTheme, slug, theme, projects, projectId]);

  const answered = remote?.query === trimmed ? remote : null;
  const cardCommands = useMemo<Command[]>(() => {
    if (!slug) return [];
    const loaded = view?.cards ?? [];
    const hits = searching
      ? [
          ...(answered?.cards ?? []),
          ...loaded.filter((card) => matchesSearch(card, trimmed)),
        ]
      : loaded;
    const seen = new Set<string>();
    return hits
      .filter((card) => !seen.has(card.id) && seen.add(card.id))
      .slice(0, searching ? 20 : undefined)
      .map((card) => ({
        id: `card:${card.id}`,
        label: card.title,
        group: "Issues" as const,
        hint: card.taskId ?? undefined,
        lane: card.columnKey,
        run: () => {
          void navigate({
            to: "/w/$slug/issues/$taskId",
            params: { slug, taskId: card.taskId ?? card.id },
          });
        },
      }));
  }, [answered, navigate, searching, slug, trimmed, view]);
  // Loaded cards only: the service was asked for this query and could not say.
  const offline = searching && answered !== null && answered.cards === null;

  const needle = trimmed.toLowerCase();
  const byText = (command: Command) =>
    `${command.hint ?? ""} ${command.label} ${command.detail ?? ""}`
      .toLowerCase()
      .includes(needle);
  const found = !needle
    ? [...cardCommands, ...commands].slice(0, 12)
    : searching
      ? [...cardCommands, ...commands.filter(byText)]
      : [...cardCommands, ...commands].filter(byText);
  // A task id that is not among the loaded cards still opens (FE-17/D4). A
  // board is read one page per group, so "not loaded" is not "not there": the
  // card page asks the service for it by that id, and says so if it is not a
  // card.
  const taskId = /^[a-z][a-z0-9]*-\d+$/i.test(needle)
    ? query.trim().toUpperCase()
    : null;
  const matches =
    slug &&
    taskId &&
    !cardCommands.some((command) => command.hint?.toUpperCase() === taskId)
      ? [
          {
            id: `jump:${taskId}`,
            label: `Open ${taskId}`,
            group: "Issues",
            hint: taskId,
            run: () =>
              void navigate({
                to: "/w/$slug/issues/$taskId",
                params: { slug, taskId },
              }),
          } satisfies Command,
          ...found,
        ]
      : found;
  // Drawn section by section, so ↑ ↓ walk them in the order they show.
  const ordered = GROUPS.flatMap((group) =>
    matches.filter((command) => command.group === group),
  );
  const cursor = Math.min(at, Math.max(0, ordered.length - 1));
  const activeId = ordered[cursor]?.id;

  // One highlight that slides to the active row, by pointer or by ↑ ↓, as
  // the rail's hover does. It jumps into place when the palette opens.
  const [box, setBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const placed = useRef(false);
  const reduced = useReducedMotion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new result list moves the active row, so it is measured again
  useLayoutEffect(() => {
    if (!isOpen) {
      placed.current = false;
      setBox(null);
      return;
    }
    const row = activeId ? document.getElementById(activeId) : null;
    if (!row) return setBox(null);
    // ↑ ↓ past the visible rows scroll the list along.
    row.scrollIntoView({ block: "nearest" });
    // The list is the rows' offset parent: fieldsets are not positioned.
    setBox({
      x: row.offsetLeft,
      y: row.offsetTop,
      width: row.offsetWidth,
      height: row.offsetHeight,
    });
  }, [isOpen, activeId, ordered.length]);
  const jump = reduced || !placed.current;
  useEffect(() => {
    if (box) placed.current = true;
  }, [box]);

  const pick = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        // A frosted page behind it rather than a dark one: the palette is a
        // quick look, not a modal task.
        overlayClassName="bg-background/45 supports-backdrop-filter:backdrop-blur-[3px]"
        className="top-[14%] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-2xl p-0 shadow-[0_24px_60px_-16px_rgb(0_0_0/0.22)] sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <div className="flex h-12 items-center gap-2.5 px-4">
          <HugeiconsIcon
            icon={Search01Icon}
            className="text-muted-foreground size-4 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            // A palette that opens without the caret in its field needs a
            // second keystroke to do the one thing it exists for.
            autoFocus
            aria-label="Search and commands"
            aria-controls="command-palette-list"
            aria-activedescendant={ordered[cursor]?.id}
            placeholder="Search cards, projects and commands…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setAt(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setAt((value) => Math.min(value + 1, ordered.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setAt((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                pick(ordered[cursor]);
              }
            }}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[14px] outline-none"
          />
          {/* The key that opens it, and closes it again. */}
          <KbdGroup aria-label="Command K" className="shrink-0">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </div>
        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="relative flex max-h-[min(26rem,60vh)] flex-col overflow-y-auto px-2 pb-2"
        >
          {box && (
            <motion.div
              aria-hidden="true"
              className="bg-rail-active pointer-events-none absolute top-0 left-0 rounded-lg"
              initial={false}
              animate={box}
              transition={jump ? { duration: 0 } : RAIL_SPRING}
            />
          )}
          {offline && (
            <p className="text-muted-foreground px-2.5 pt-1 pb-1.5 text-[11px]">
              Showing loaded cards only
            </p>
          )}
          {ordered.length === 0 && (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyTitle>No matches</EmptyTitle>
                <EmptyDescription>
                  Nothing matches “{query.trim()}”.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {GROUPS.map((group) => {
            const rows = ordered.filter((command) => command.group === group);
            if (rows.length === 0) return null;
            return (
              <fieldset
                key={group}
                aria-label={group}
                className="m-0 min-w-0 border-0 p-0"
              >
                <div className="text-muted-foreground px-2.5 pt-2.5 pb-1 text-[12px] font-medium">
                  {group}
                </div>
                {rows.map((command) => {
                  const index = ordered.indexOf(command);
                  return (
                    <button
                      key={command.id}
                      id={command.id}
                      type="button"
                      role="option"
                      aria-selected={index === cursor}
                      onMouseEnter={() => setAt(index)}
                      onClick={() => pick(command)}
                      className="relative flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left"
                    >
                      {/* The first line's middle: a 20px line, a 16px mark. */}
                      <span className="flex h-5 shrink-0 items-center">
                        {command.lane ? (
                          <StatusIcon
                            column={columnOf(view?.columns ?? [], command.lane)}
                          />
                        ) : (
                          command.icon && (
                            <HugeiconsIcon
                              icon={command.icon}
                              className="text-muted-foreground size-4"
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                          )
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] leading-5">
                          {command.label}
                        </span>
                        {command.detail && (
                          <span className="text-muted-foreground truncate text-[12px] leading-4">
                            {command.detail}
                          </span>
                        )}
                      </span>
                      {command.hint && (
                        <span className="text-muted-foreground shrink-0 font-mono text-[11.5px] leading-5">
                          {command.hint}
                        </span>
                      )}
                      {command.keys && (
                        // The first line's middle, as the mark on the left.
                        <KbdGroup className="h-5 shrink-0">
                          {command.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      )}
                    </button>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
        <div className="border-border bg-muted/40 text-muted-foreground flex h-10 items-center gap-4 border-t px-4 text-[12px]">
          <span className="flex items-center gap-1.5">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            Select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
