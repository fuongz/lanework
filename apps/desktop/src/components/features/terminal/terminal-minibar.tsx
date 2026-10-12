import {
  ArrowUp01Icon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge";
import { useTerminal } from "#/stores/terminal";

/**
 * What the terminal panel folds into when it is hidden: one line at the foot
 * of the content column — "Terminal", and how many this project has — that
 * opens it again.
 *
 * ⚠️ There for a project with NO terminal as well, with no count. It is where
 * the panel went, so it cannot vanish along with the last shell; opening it
 * from here starts one, the same as ⌘`.
 *
 * ⚠️ A start that failed lands here too, and says why: there is no empty
 * panel left open to carry the error (FE-19).
 */
export function TerminalMinibar({
  workspace,
  usage,
}: {
  workspace: string;
  /** What sits at the bar's right end: Claude's usage strip (FE-53). */
  usage?: ReactNode;
}) {
  const count = useTerminal((state) => state.sessions[workspace]?.length ?? 0);
  const error = useTerminal((state) => state.error);
  const toggle = useTerminal((state) => state.toggle);

  return (
    <div className="border-panel-rule bg-background flex h-8 shrink-0 items-center gap-2 border-t px-2">
      <button
        type="button"
        title="Show terminal (⌘`)"
        onClick={() => void toggle(workspace)}
        className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors"
      >
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          className="size-3.5 shrink-0"
          strokeWidth={1.6}
          aria-hidden="true"
        />
        Terminal
        {/* The space is for the accessible name ("Terminal 2"); a flex row
            draws none. */}
        {count > 0 && " "}
        {count > 0 && (
          <Badge variant="secondary" className="h-4 min-w-4 px-1 tabular-nums">
            {count}
          </Badge>
        )}
        <HugeiconsIcon
          icon={ArrowUp01Icon}
          className="size-3 shrink-0 opacity-60"
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {error && (
        <p role="alert" className="text-destructive min-w-0 truncate text-xs">
          {error}
        </p>
      )}
      <div className="ml-auto flex min-w-0 items-center">{usage}</div>
    </div>
  );
}
