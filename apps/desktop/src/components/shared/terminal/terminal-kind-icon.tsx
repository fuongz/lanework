import { ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TerminalKind } from "#/../shared/terminal";
import { ClaudeAiIcon } from "#/components/ui/svgs/claudeAiIcon";
import { CodexDark } from "#/components/ui/svgs/codexDark";
import { CodexLight } from "#/components/ui/svgs/codexLight";
import { cn } from "#/lib/utils";

/** What the + menu calls each kind, and what an agent tab is named after. */
export const TERMINAL_KIND_LABELS: Record<TerminalKind, string> = {
  shell: "Terminal",
  claude: "Claude",
  codex: "Codex",
};

/**
 * The mark for a kind of tab: a terminal glyph, or the agent's own.
 *
 * Shared by the + menu and the tab strip, so "which mark is Codex" has one
 * answer.
 *
 * NOTE: Codex is two marks with one visible, by CSS rather than a theme hook.
 * The `.dark` class is on `<html>` before the first paint, and a hook would
 * draw the light mark for one frame on a dark panel.
 */
export function TerminalKindIcon({
  kind,
  className,
}: {
  kind: TerminalKind;
  className?: string;
}) {
  if (kind === "claude")
    return <ClaudeAiIcon aria-hidden="true" className={className} />;
  if (kind === "codex")
    return (
      <>
        <CodexLight
          aria-hidden="true"
          className={cn("dark:hidden", className)}
        />
        <CodexDark
          aria-hidden="true"
          className={cn("hidden dark:block", className)}
        />
      </>
    );
  return (
    <HugeiconsIcon
      icon={ComputerTerminal01Icon}
      className={className}
      strokeWidth={1.6}
      aria-hidden="true"
    />
  );
}
