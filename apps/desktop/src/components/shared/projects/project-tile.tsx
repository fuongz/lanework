import { useEffect, useState } from "react";
import type { Project } from "#/../shared/projects";
import { cn } from "#/lib/utils";

/**
 * Icons main returned this session, by `id|iconKey`.
 *
 * A tile drawn again (the switcher reopening, another project picked) has its
 * image on the first frame instead of flashing the letter.
 */
const answers = new Map<string, string | null>();

const iconKeyOf = (project: Project | null) =>
  project?.id ? `${project.id}|${project.iconKey ?? ""}` : null;

/**
 * A project's icon as a `data:` URL.
 *
 * @returns null for the letter tile: no GitHub repo, not read yet, or a
 *   project with no cloud id.
 */
function useProjectIcon(project: Project | null): string | null {
  const key = iconKeyOf(project);
  const [url, setUrl] = useState(() =>
    key ? (answers.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!key || !project?.id) {
      setUrl(null);
      return;
    }
    if (answers.has(key)) {
      setUrl(answers.get(key) ?? null);
      return;
    }
    let live = true;
    const surface = window.desktop?.projects;
    if (!surface) return;
    surface
      .icon(project.id, project.iconKey ?? null)
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
  }, [key, project?.id, project?.iconKey]);

  return url;
}

/**
 * The colours a project's letter tile is drawn in, picked by its slug.
 *
 * Derived from the slug, not stored and not by list position. A colour from
 * the index would change when somebody creates a project earlier in the
 * alphabet, and the point of a colour is that it is the same tile every time.
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
 * A project's mark: its GitHub repo owner's avatar, or else its initial on a
 * colour picked by its slug.
 *
 * Shared by the project switcher and Settings → Projects, so a project wears
 * one face in both.
 */
export function ProjectTile({
  project,
  className,
}: {
  project: Project | null;
  className?: string;
}) {
  const icon = useProjectIcon(project);
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
        project ? tile(project.slug) : "bg-muted-foreground",
        className,
      )}
    >
      {(project?.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
