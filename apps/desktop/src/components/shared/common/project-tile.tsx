import { useEffect, useState } from "react";
import type { Workspace } from "#/../shared/workspaces";
import { cn } from "#/lib/utils";

/**
 * What main answered this session, by `id|iconKey`, so a tile drawn again —
 * the switcher reopening, another project picked — has its image on the first
 * frame instead of flashing the letter.
 */
const answers = new Map<string, string | null>();

const iconKeyOf = (workspace: Workspace | null) =>
  workspace?.id ? `${workspace.id}|${workspace.iconKey ?? ""}` : null;

/**
 * A project's icon (BE-18) as a `data:` URL, or null for the letter tile —
 * no GitHub repo, not read yet, or a project with no cloud id.
 */
function useWorkspaceIcon(workspace: Workspace | null): string | null {
  const key = iconKeyOf(workspace);
  const [url, setUrl] = useState(() =>
    key ? (answers.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!key || !workspace?.id) {
      setUrl(null);
      return;
    }
    if (answers.has(key)) {
      setUrl(answers.get(key) ?? null);
      return;
    }
    let live = true;
    const surface = window.desktop?.workspaces;
    if (!surface) return;
    surface
      .icon(workspace.id, workspace.iconKey ?? null)
      .then((answer) => {
        answers.set(key, answer);
        if (live) setUrl(answer);
      })
      .catch(() => {
        // No icon is the honest answer; the letter stays.
      });
    return () => {
      live = false;
    };
  }, [key, workspace?.id, workspace?.iconKey]);

  return url;
}

/**
 * A project's colour, derived from its slug.
 *
 * ⚠️ Derived, not stored and not by list position. A colour that came from the
 * index would change the moment somebody creates a project earlier in the
 * alphabet — and the whole point of giving each one a colour is that it is the
 * same tile every time you open the menu.
 */
const TILES = [
  "bg-tone-violet",
  "bg-tone-sky",
  "bg-tone-emerald",
  "bg-tone-amber",
  "bg-tone-teal",
  "bg-tone-rose",
  "bg-tone-blue",
] as const;

function tile(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILES[hash % TILES.length];
}

/**
 * A project's mark: its GitHub repo owner's avatar (BE-18), or its initial
 * on a colour picked by its slug when there is none. Shared by the project
 * switcher and Settings → Projects, so a project wears one face in both.
 */
export function ProjectTile({
  workspace,
  className,
}: {
  workspace: Workspace | null;
  className?: string;
}) {
  const icon = useWorkspaceIcon(workspace);
  if (icon)
    return (
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-project-icon=""
        className={cn(
          "bg-muted shrink-0 rounded-md object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10",
          className,
        )}
      />
    );
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-md font-semibold text-white",
        workspace ? tile(workspace.slug) : "bg-muted-foreground",
        className,
      )}
    >
      {(workspace?.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
