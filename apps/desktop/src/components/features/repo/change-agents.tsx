import { useNavigate, useParams } from "@tanstack/react-router";
import type { AgentFileMark } from "#/../shared/terminal";
import {
  TERMINAL_KIND_LABELS,
  TerminalKindIcon,
} from "#/components/shared/terminal/terminal-kind-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import { useProjectKey } from "#/hooks/use-project-key";
import { useAgentSessions } from "#/stores/agent-sessions";
import { useAgentTerminals } from "#/stores/agent-terminals";
import { useWorktree } from "#/stores/worktree";

/** A stable empty: a selector that allocated one would re-render forever. */
const NONE: AgentFileMark[] = [];
/** The most marks drawn on a row (FE-39/D2); the menu lists every one. */
const SHOWN = 3;

const MARK_BUTTON =
  "hover:bg-foreground/[0.08] focus-visible:ring-accent-brand flex h-5 shrink-0 items-center rounded px-0.5 outline-none focus-visible:ring-2";

/** One conversation, as a mark's tooltip and menu name it. */
function named(mark: AgentFileMark): string {
  return mark.via
    ? `${mark.title} (via ${mark.via.type ?? "sub-agent"})`
    : mark.title;
}

/** The agents' marks, overlapping like avatars, newest edit in front. */
function Stack({ marks }: { marks: AgentFileMark[] }) {
  return (
    <span className="flex items-center -space-x-1">
      {marks.slice(0, SHOWN).map((mark, index) => (
        <span
          key={`${mark.agent}:${mark.id}`}
          style={{ zIndex: SHOWN - index }}
          className="bg-sidebar ring-sidebar relative flex size-4 items-center justify-center rounded-full ring-1"
        >
          <TerminalKindIcon kind={mark.agent} className="size-3" />
        </span>
      ))}
    </span>
  );
}

/**
 * Which agent conversations edited a changed file since HEAD's commit.
 *
 * Their marks, a tooltip naming them, and a click that opens one the way its
 * row on the rail does (FE-39/D2, D3).
 *
 * Only edits made with the agents' file tools count. A file an agent changed
 * through the shell carries no mark, which is not proof it did not.
 */
export function ChangeAgents({ path }: { path: string }) {
  const { slug } = useParams({ from: "/_app/w/$slug/changes" });
  const project = useProjectKey(slug);
  const navigate = useNavigate();
  const resume = useAgentTerminals((state) => state.resume);
  const marks = useWorktree((state) => state.agentMarks?.files[path] ?? NONE);
  if (!project || marks.length === 0) return null;

  /** Resume it, or go to its agent if one runs (FE-23/D6). */
  const open = async (mark: AgentFileMark) => {
    const find = () =>
      useAgentSessions
        .getState()
        .byProject[project]?.find(
          (entry) => entry.agent === mark.agent && entry.id === mark.id,
        );
    if (!find()) await useAgentSessions.getState().load(project);
    const session = find();
    if (!session) return;
    const terminal = await resume(project, session);
    if (terminal)
      void navigate({
        to: "/w/$slug/agents/$terminalId",
        params: { slug, terminalId: terminal.id },
      });
  };

  if (marks.length === 1) {
    const [mark] = marks as [AgentFileMark];
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Edited by “${mark.title}” in ${TERMINAL_KIND_LABELS[mark.agent]}`}
              onClick={() => void open(mark)}
              className={MARK_BUTTON}
            />
          }
        >
          <Stack marks={marks} />
        </TooltipTrigger>
        <TooltipContent>{named(mark)}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              aria-label={`Edited by ${marks.length} conversations`}
              className={MARK_BUTTON}
            />
          }
        >
          <Stack marks={marks} />
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex flex-col gap-0.5">
            {marks.map((mark) => (
              <span key={`${mark.agent}:${mark.id}`}>{named(mark)}</span>
            ))}
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        {marks.map((mark) => (
          <DropdownMenuItem
            key={`${mark.agent}:${mark.id}`}
            className="text-[13px]"
            onClick={() => void open(mark)}
          >
            <TerminalKindIcon kind={mark.agent} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{mark.title}</span>
            {mark.via && (
              <span className="text-muted-foreground shrink-0 text-[11px]">
                via {mark.via.type ?? "sub-agent"}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
