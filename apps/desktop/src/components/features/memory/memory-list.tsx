import { Link } from "@tanstack/react-router";
import {
  MEMORY_INDEX,
  MEMORY_TYPES,
  type MemoryEntry,
  type MemoryList as MemoryListing,
} from "#/../shared/memory";
import { INDEX_NAME, MEMORY_TYPE_LABELS, memoryLabel } from "#/lib/memory";

const newestFirst = (a: MemoryEntry, b: MemoryEntry) =>
  Date.parse(b.modified) - Date.parse(a.modified);

function Row({
  slug,
  entry,
  name,
  description,
}: {
  slug: string;
  entry: MemoryEntry;
  name: string;
  description: string | null;
}) {
  return (
    <Link
      to="/w/$slug/memory/$file"
      params={{ slug, file: entry.file }}
      className="hover:bg-foreground/[0.04] aria-[current]:bg-foreground/[0.06] focus-visible:ring-accent-brand flex min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 outline-none focus-visible:ring-2"
    >
      <span className="min-w-0 truncate text-[13px]">{name}</span>
      {description && (
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {description}
        </span>
      )}
    </Link>
  );
}

/**
 * Every memory, by kind (FE-36/D5): the index pinned first, then User,
 * Feedback, Project, Reference and Other — each newest first, and a kind
 * with none left out.
 */
export function MemoryList({
  slug,
  list,
}: {
  slug: string;
  list: MemoryListing;
}) {
  const index = list.entries.find((entry) => entry.file === MEMORY_INDEX);
  const groups = MEMORY_TYPES.map((type) => ({
    type,
    entries: list.entries
      .filter((entry) => entry.file !== MEMORY_INDEX && entry.type === type)
      .sort(newestFirst),
  })).filter((group) => group.entries.length > 0);

  return (
    <nav
      aria-label="Memories"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1.5"
    >
      {index && (
        <Row
          slug={slug}
          entry={index}
          name={INDEX_NAME}
          description="What Claude reads at the start of every conversation"
        />
      )}
      {groups.map((group) => (
        <div key={group.type} className="flex flex-col">
          <h3 className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide uppercase">
            {MEMORY_TYPE_LABELS[group.type]}
          </h3>
          {group.entries.map((entry) => (
            <Row
              key={entry.file}
              slug={slug}
              entry={entry}
              name={memoryLabel(entry)}
              description={entry.description}
            />
          ))}
        </div>
      ))}
      {list.truncated && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs">
          More memories than one listing shows. Reveal the folder to see them
          all.
        </p>
      )}
    </nav>
  );
}
