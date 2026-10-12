import {
  DndContext,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Add01Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useRef } from "react";
import {
  TERMINAL_LIMITS,
  type TerminalKind,
  type TerminalSession,
} from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import { XtermPane } from "#/components/shared/terminal/xterm-pane";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { useTerminal } from "#/stores/terminal";
import { TerminalTab } from "./terminal-tab";

/** Stable empty list: a selector that allocated one would re-render forever. */
const NO_SESSIONS: TerminalSession[] = [];

/** How far the pointer travels before it is a drag rather than a click. */
const DRAG_PX = 6;

/**
 * The bottom panel: this project's terminals as tabs, and the one shown.
 *
 * ⚠️ Only THIS project's tabs. Every other project's shells keep running in
 * the host while you are away from it — switching projects is a change of
 * which list is drawn, never a change to the shells (FE-19/D4).
 *
 * ⚠️ Hiding the panel hides; it does not close anything. Only the × on a tab
 * stops a shell. Hidden, it folds into `TerminalMinibar`.
 *
 * ⚠️ Never empty: the shell shows this only while the project has a terminal
 * or one is starting (`terminalShown`), and closing the last tab folds it
 * away — so there is no "no terminal" state to draw here.
 */
export function TerminalPanel({
  workspace,
  usage,
}: {
  workspace: string;
  /** What sits left of + and hide: Claude's usage strip (FE-53). */
  usage?: ReactNode;
}) {
  const sessions = useTerminal(
    (state) => state.sessions[workspace] ?? NO_SESSIONS,
  );
  const activeId = useTerminal((state) => state.active[workspace]);
  const error = useTerminal((state) => state.error);
  const spawning = useTerminal((state) => state.spawning);
  const spawn = useTerminal((state) => state.spawn);
  const close = useTerminal((state) => state.close);
  const select = useTerminal((state) => state.select);
  const reorderTab = useTerminal((state) => state.reorderTab);
  const moveTab = useTerminal((state) => state.moveTab);
  const setOpen = useTerminal((state) => state.setOpen);

  const active =
    sessions.find((session) => session.id === activeId) ?? sessions.at(-1);
  const full = sessions.length >= TERMINAL_LIMITS.perWorkspace;
  // ⚠️ Shells only (FE-26/D3). Claude and Codex start from the rail's
  // Agents group and run full size in the main view, not as tabs down here.
  const kinds: TerminalKind[] = ["shell"];

  // A small threshold, so a plain click still picks the tab.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_PX } }),
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const over = event.over?.id;
      if (over && over !== event.active.id)
        reorderTab(workspace, String(event.active.id), String(over));
    },
    [workspace, reorderTab],
  );
  const stripRef = useRef<HTMLUListElement>(null);
  // Along the strip and inside it: a diagonal pointer cannot lift a tab out
  // of its row, or past either end of it.
  const alongStrip: Modifier = useCallback(
    ({ transform, draggingNodeRect }) => {
      const bounds = stripRef.current?.getBoundingClientRect();
      if (!bounds || !draggingNodeRect) return { ...transform, y: 0 };
      const x = Math.min(
        bounds.right - draggingNodeRect.right,
        Math.max(bounds.left - draggingNodeRect.left, transform.x),
      );
      return { ...transform, x, y: 0 };
    },
    [],
  );

  return (
    <section
      aria-label="Terminal"
      className="bg-background flex h-full min-h-0 flex-col"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 pr-1.5 pl-1">
        {/* ⚠️ OUTSIDE the list: dnd-kit renders its screen-reader text in
            place, not in a portal, and a div is not a list item. */}
        <DndContext
          sensors={sensors}
          onDragEnd={onDragEnd}
          modifiers={[alongStrip]}
        >
          {/* ⚠️ The strip's own padding is the room a lifted tab's ring and
              shadow draw into: `overflow-x-auto` clips BOTH axes, so a tab
              that filled the strip's height would lose them at the edges. */}
          <ul
            ref={stripRef}
            aria-label="Terminals"
            className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
          >
            {sessions.map((session, index) => (
              <TerminalTab
                key={session.id}
                session={session}
                index={index}
                current={session.id === active?.id}
                onSelect={() => select(workspace, session.id)}
                onClose={() => void close(workspace, session.id)}
                onMove={(delta) => moveTab(workspace, session.id, delta)}
              />
            ))}
          </ul>
        </DndContext>
        {usage}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="New terminal"
                title={
                  full
                    ? `At most ${TERMINAL_LIMITS.perWorkspace} terminals per project`
                    : "New terminal"
                }
                disabled={spawning || full}
              />
            }
          >
            <HugeiconsIcon
              icon={Add01Icon}
              className="size-3.5"
              strokeWidth={2}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {kinds.map((kind) => (
              <DropdownMenuItem
                key={kind}
                onClick={() => void spawn(workspace, kind)}
              >
                <TerminalKindIcon kind={kind} className="size-4 shrink-0" />
                {TERMINAL_KIND_LABELS[kind]}
                {kind === "shell" && (
                  <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Hide terminal"
          title="Hide terminal (⌘`)"
          onClick={() => setOpen(workspace, false)}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3.5"
            strokeWidth={2}
          />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive px-3 pb-1 text-xs">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {/* Nothing here only while the first one is starting. */}
        {active && <XtermPane key={active.id} session={active} />}
      </div>
    </section>
  );
}
