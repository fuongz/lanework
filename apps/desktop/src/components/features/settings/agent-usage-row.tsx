import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AgentUsage, AgentUsageTotals } from "#/../shared/terminal";
import { COST_NOTE } from "#/components/shared/agents/conversation-facts";
import { costText, tokenText } from "#/components/shared/agents/facts";
import { Button } from "#/components/ui/button";
import { ipcMessage } from "#/lib/ipc-error";

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

/** One agent's line in a window: `Claude ≈ $12.40, 3.2M in, 410k out, 5 conversations`. */
function totalsText(name: string, totals: AgentUsageTotals): string | null {
  if (totals.conversations === 0 && totals.input + totals.output === 0)
    return null;
  const facts = [
    totals.costUSD !== null ? costText(totals.costUSD) : null,
    `${tokenText(totals.input)} in, ${tokenText(totals.output)} out`,
    plural(totals.conversations, "conversation"),
  ].filter(Boolean);
  return `${name} ${facts.join(", ")}`;
}

/**
 * A project's agent usage over the last 7 and 30 days (FE-38/D6), as a row
 * of Settings → Projects: Claude's cost estimate, both CLIs' tokens, and how
 * many conversations. The row itself is the caller's, so it reads as the
 * section's other rows.
 *
 * ⚠️ Counted when this mounts — the section being shown — and on Recount,
 * never in the background: it reads the end of every transcript the folder
 * had this month.
 */
export function AgentUsageRow({
  workspace,
  children,
}: {
  /** The project's terminal key: its cloud id, or its slug. */
  workspace: string;
  children: (row: { description: ReactNode; control: ReactNode }) => ReactNode;
}) {
  /** `undefined` while counting; `null` when the project has no folder here. */
  const [usage, setUsage] = useState<AgentUsage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const count = useCallback(() => {
    const surface = window.desktop?.terminal;
    if (!surface) return;
    setUsage(undefined);
    setError(null);
    surface
      .agentUsage(workspace)
      .then(setUsage)
      .catch((reason: unknown) => {
        setUsage(null);
        setError(ipcMessage(reason, "Could not count this project's usage."));
      });
  }, [workspace]);

  useEffect(() => count(), [count]);

  let description: ReactNode;
  if (error) description = error;
  else if (usage === undefined) description = "Counting…";
  // ⚠️ Not "No folder on this machine": the Folders row above already says
  // so, and the page names a missing folder once per place, not twice.
  else if (usage === null)
    description = "Agents run in a folder: link one to count what they spent.";
  else {
    const lines = usage.windows.map((window) => ({
      days: window.days,
      parts: [
        totalsText("Claude", window.claude),
        totalsText("Codex", window.codex),
      ].filter((part): part is string => part !== null),
    }));
    const longest = usage.windows.at(-1)?.days ?? 30;
    description = lines.every((line) => line.parts.length === 0) ? (
      `No Claude or Codex conversation in the last ${longest} days.`
    ) : (
      <span
        data-testid="agent-usage"
        title={COST_NOTE}
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5"
      >
        {lines.map((line) => (
          <span key={line.days} className="contents">
            <span className="text-foreground">Last {line.days} days</span>
            <span className="flex flex-col">
              {line.parts.length === 0 ? (
                <span>None</span>
              ) : (
                line.parts.map((part) => <span key={part}>{part}</span>)
              )}
            </span>
          </span>
        ))}
        {usage.skipped > 0 && (
          <span className="col-span-2">
            {plural(usage.skipped, "conversation")} too long to total{" "}
            {usage.skipped === 1 ? "is" : "are"} left out.
          </span>
        )}
      </span>
    );
  }

  return children({
    description,
    control: (
      <Button
        variant="outline"
        disabled={usage === undefined && !error}
        onClick={count}
      >
        {usage === undefined && !error ? "Counting…" : "Recount"}
      </Button>
    ),
  });
}
