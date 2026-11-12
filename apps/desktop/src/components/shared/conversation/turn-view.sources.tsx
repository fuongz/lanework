import { cn } from "#/lib/utils";
import type { WebSource } from "#/lib/web-sources";
import { LinkIcon } from "./link-icon";

/** How many marks the button stacks. */
const STACKED = 3;

/** A source's mark: its site's favicon when well known, else GitHub's or the globe. */
function SourceMark({ host, className }: { host: string; className?: string }) {
  return <LinkIcon host={host} className={className} />;
}

/**
 * "N sources" at the end of an answer's actions: the marks of its first
 * hosts, stacked, and the count. It shows or hides {@link SourcesList}.
 */
export function SourcesButton({
  sources,
  open,
  onToggle,
  controls,
}: {
  sources: WebSource[];
  open: boolean;
  onToggle: () => void;
  /** The list's id, for `aria-controls`. */
  controls: string;
}) {
  const hosts = [...new Set(sources.map((source) => source.host))].slice(
    0,
    STACKED,
  );
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] ms-1 flex h-7 shrink-0 items-center gap-1.5 rounded-full ps-1 pe-2.5 text-xs transition-colors",
        open && "bg-foreground/[0.05] text-foreground",
      )}
    >
      <span className="flex items-center">
        {hosts.map((host, index) => (
          <span
            key={host}
            className={cn(
              "bg-muted ring-background grid size-5 place-items-center rounded-full ring-2",
              index > 0 && "-ms-1.5",
            )}
          >
            <SourceMark host={host} className="size-3" />
          </span>
        ))}
      </span>
      {sources.length} {sources.length === 1 ? "source" : "sources"}
    </button>
  );
}

/**
 * An answer's sources, under its actions: one row each, its title (or its
 * host) and its host; a click opens it in the browser.
 */
export function SourcesList({
  id,
  sources,
}: {
  id: string;
  sources: WebSource[];
}) {
  return (
    <ul
      id={id}
      aria-label="Sources"
      className="bg-muted/50 mt-1 flex max-h-72 flex-col overflow-y-auto rounded-xl p-1 dark:bg-foreground/[0.04]"
    >
      {sources.map((source) => (
        <li key={source.url}>
          <button
            type="button"
            title={source.url}
            // Main opens it in the browser, http(s) only, as a chat link.
            onClick={() =>
              void window.desktop?.conversation.openLink(source.url)
            }
            className="group/source hover:bg-foreground/[0.04] flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors"
          >
            <SourceMark host={source.host} className="text-muted-foreground" />
            <span className="text-foreground/85 min-w-0 flex-1 truncate underline-offset-[3px] group-hover/source:underline">
              {source.title ?? source.host}
            </span>
            {source.fetched && (
              <span className="bg-foreground/[0.05] text-muted-foreground shrink-0 rounded px-1.5 py-px text-[11px]">
                Read
              </span>
            )}
            <span className="text-muted-foreground max-w-48 shrink-0 truncate font-mono text-[11px]">
              {source.host}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
