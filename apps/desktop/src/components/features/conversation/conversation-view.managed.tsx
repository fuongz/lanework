import { Link } from "@tanstack/react-router";
import type { TeamLead } from "#/../shared/orchestration";
import { ConductorMark } from "#/components/shared/conductors/conductor-mark";

/**
 * Where the composer would be in a session a conductor started and did not
 * let the user work in (`sessions.access`): who manages it, and the way to
 * that conductor, the one to ask.
 *
 * @param conductor The conductor, once the leads are read; null until then,
 *   or when it is gone, and the notice names no one.
 */
export function ManagedNotice({
  slug,
  conductor,
}: {
  slug: string;
  conductor: Pick<TeamLead, "id" | "name" | "icon"> | null;
}) {
  return (
    <p className="text-muted-foreground border-border rounded-xl border px-4 py-3 text-[13px]">
      Managed by{" "}
      {conductor ? (
        <Link
          to="/w/$slug/conductors/$lead"
          params={{ slug, lead: conductor.id }}
          className="text-foreground inline-flex items-baseline gap-1 underline-offset-2 hover:underline"
        >
          <ConductorMark
            lead={conductor}
            className="size-3.5 shrink-0 self-center"
            strokeWidth={1.5}
          />
          {conductor.name}
        </Link>
      ) : (
        "its conductor"
      )}
      . It takes its instructions from the conductor.
    </p>
  );
}
