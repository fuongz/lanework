import { HugeiconsIcon } from "@hugeicons/react";
import type { TeamLead } from "#/../shared/orchestration";
import { AvatarFace } from "#/components/shared/projects/project-avatar";
import { leadIcon } from "#/lib/orchestration-prompt";
import { cn } from "#/lib/utils";

/**
 * A conductor's mark wherever it is named: its avatar when one is chosen (a
 * project's kind: icon, emoji or letter on a colour), else its line icon.
 *
 * `className` sizes it as it sized the icon; a colour in it tints only the
 * line icon, never the avatar's white face.
 */
export function ConductorMark({
  lead,
  className,
  strokeWidth = 1.5,
}: {
  lead: Pick<TeamLead, "icon" | "avatar"> | null | undefined;
  className?: string;
  strokeWidth?: number;
}) {
  if (lead?.avatar)
    return (
      <AvatarFace
        avatar={lead.avatar}
        className={cn(
          className,
          "rounded-[28%] text-[0.6em] font-semibold text-white",
        )}
      />
    );
  return (
    <HugeiconsIcon
      icon={leadIcon(lead?.icon)}
      className={className}
      strokeWidth={strokeWidth}
      aria-hidden="true"
    />
  );
}
