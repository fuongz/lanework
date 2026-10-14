import {
  Alert02Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import type {
  ReadinessCheck,
  ReadinessFix,
  ReadinessReport,
} from "#/../shared/readiness";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

function StatusIcon({ check }: { check: ReadinessCheck }) {
  const [icon, tone, label] = check.ok
    ? [CheckmarkCircle02Icon, "text-tone-emerald", "Ready"]
    : check.level === "blocker"
      ? [AlertCircleIcon, "text-destructive", "Blocker"]
      : check.level === "warning"
        ? [Alert02Icon, "text-tone-amber", "Warning"]
        : [InformationCircleIcon, "text-muted-foreground", "Note"];
  return (
    <HugeiconsIcon
      icon={icon}
      className={cn("mt-px size-4 shrink-0", tone)}
      strokeWidth={1.8}
      aria-label={label}
    />
  );
}

/** The file each fix writes — the button says which, not just "Fix…". */
const FIX_FILE: Record<ReadinessFix, string> = {
  "agents-md": "AGENTS.md",
  "claude-md": "CLAUDE.md",
  "mcp-json": ".mcp.json",
};

/** Failed blockers first, then warnings, then notes, then what passed. */
const ORDER = { blocker: 0, warning: 1, info: 2 } as const;
const rank = (check: ReadinessCheck) => (check.ok ? 3 : ORDER[check.level]);

/**
 * A project's readiness checks, each with the one thing to do about it
 * (FE-30): a Fix that previews its change, or the settings page that fixes it.
 * Passed checks are listed too, after the ones still to do.
 *
 * ⚠️ The Fix dialog is the CALLER's, via `onFix`, so it outlives a fix that
 * changes this list.
 */
export function ReadinessList({
  report,
  onFix,
  className,
}: {
  report: ReadinessReport;
  onFix: (fix: ReadinessFix) => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const checks = [...report.checks].sort((a, b) => rank(a) - rank(b));

  function go(action: "project-settings" | "agent-settings") {
    void navigate({
      to:
        action === "agent-settings"
          ? "/settings/agents"
          : "/settings/workspaces",
    });
  }

  return (
    <ul className={cn("flex flex-col", className)}>
      {checks.map((check) => (
        <li key={check.id} className="flex items-start gap-2.5 py-2">
          <StatusIcon check={check} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[13px] font-medium">{check.title}</span>
            {!check.ok && (
              <span className="text-muted-foreground text-xs leading-relaxed break-words">
                {check.detail}
              </span>
            )}
          </div>
          {!check.ok && check.fix && (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Fix ${check.title}`}
              onClick={() => check.fix && onFix(check.fix)}
            >
              Fix {FIX_FILE[check.fix]}
            </Button>
          )}
          {!check.ok && !check.fix && check.action && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => check.action && go(check.action)}
            >
              Open settings
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
