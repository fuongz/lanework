/**
 * Turning the ids on a card into faces.
 *
 * ⚠️ Everything person-shaped on this board is an ID — a comment's author, an
 * audit row's actor, a card's assignee — and the directory that names them
 * arrives once, with the board config. These helpers are the only place that
 * join happens, so a member who has left the account reads the same way on every
 * surface instead of each one inventing its own fallback.
 */
import { UserIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { BoardMember } from "#/../shared/workspaces";
import { UserAvatar } from "#/components/shared/common/user-avatar";
import { cn } from "#/lib/utils";

export const memberOf = (
  members: BoardMember[],
  userId: string | null | undefined,
): BoardMember | undefined =>
  userId ? members.find((member) => member.userId === userId) : undefined;

/**
 * What to call whoever did something.
 *
 * ⚠️ Falls back to the raw ref rather than to "Unknown". A machine id or an
 * agent slug is not in the directory and never will be — an agent is not an
 * account — and the slug is the true answer to "who did this", where "Unknown"
 * would be this app refusing to repeat what the log plainly says.
 */
export function personName(
  members: BoardMember[],
  userId: string | null | undefined,
  fallback?: string | null,
): string {
  return memberOf(members, userId)?.name ?? fallback ?? userId ?? "Someone";
}

const SIZE = {
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
} as const;

/**
 * One person, or the absence of one.
 *
 * ⚠️ `title` rather than `alt` text alone, because these are drawn in rows where
 * the name is not always beside them — a stack of subscribers, an assignee
 * column — and hovering is the only way to read who they are.
 *
 * ⚠️ A picture that fails to load — or was never set — becomes the person's
 * orb (see `UserAvatar`), seeded by their user id so it matches everywhere.
 *
 * ⚠️ A missing person renders an outline, never a blank gap. "Unassigned" is a
 * state worth showing; an empty space reads as a rendering bug.
 */
export function Avatar({
  member,
  name,
  size = "md",
  className,
}: {
  member?: BoardMember;
  /** Used when there is no directory row — a machine id, an agent slug. */
  name?: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const label = member?.name ?? name;
  if (!label) {
    return (
      <HugeiconsIcon
        icon={UserIcon}
        aria-hidden="true"
        className={cn(
          "text-muted-foreground shrink-0 rounded-full",
          SIZE[size],
          className,
        )}
        strokeWidth={1.8}
      />
    );
  }
  return (
    <UserAvatar
      src={member?.image}
      seed={member?.userId ?? label}
      title={label}
      className={cn(SIZE[size], className)}
    />
  );
}

/**
 * A row of faces that overlap once there are several.
 *
 * ⚠️ Capped, with the remainder counted rather than dropped. A card followed by
 * eleven people is a fact worth stating; eight avatars and silence is not.
 */
export function AvatarStack({
  userIds,
  members,
  max = 3,
  size = "md",
}: {
  userIds: string[];
  members: BoardMember[];
  max?: number;
  size?: keyof typeof SIZE;
}) {
  if (!userIds.length) return null;
  const shown = userIds.slice(0, max);
  const rest = userIds.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((userId) => (
        <Avatar
          key={userId}
          member={memberOf(members, userId)}
          name={userId}
          size={size}
          className="ring-background -mr-1 ring-2 last:mr-0"
        />
      ))}
      {rest > 0 && (
        <span className="text-muted-foreground ml-2 text-xs tabular-nums">
          +{rest}
        </span>
      )}
    </span>
  );
}
