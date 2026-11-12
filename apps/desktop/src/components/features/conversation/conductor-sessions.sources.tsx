import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Link01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { LinkIcon } from "#/components/shared/conversation/link-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip";
import type { WebSearch, WebSource } from "#/lib/web-sources";

/** Pages listed under a search before its "Show all". */
const SHOWN = 8;

/** A row flush with the card's edge, as the panel's other groups. */
const ROW = "flex h-8 w-full min-w-0 items-center gap-2.5 px-3 text-[13px]";

/**
 * The web searches the conductor and its sessions ran, newest first, each
 * with the pages it found, then the pages read directly. Rows of the
 * panel's Sources group.
 *
 * NOTE: A favicon only for a well-known site (`FAVICON_HOSTS`), fetched
 * by main from the site itself; any other page wears the globe.
 */
export function SourceRows({
  searches,
  partial,
}: {
  searches: WebSearch[];
  partial: boolean;
}) {
  return (
    <>
      {searches.map((search, index) => (
        <SearchRows
          // biome-ignore lint/suspicious/noArrayIndexKey: one search may run twice; the order is the identity.
          key={index}
          search={search}
        />
      ))}
      {partial && (
        <li className="text-muted-foreground px-3 py-1.5 text-xs">
          Some sources could not be read.
        </li>
      )}
    </>
  );
}

function SearchRows({ search }: { search: WebSearch }) {
  const [all, setAll] = useState(false);
  // Folded to start with: a search's pages are one click in.
  const [open, setOpen] = useState(false);
  const shown = !open
    ? []
    : all
      ? search.sources
      : search.sources.slice(0, SHOWN);
  const label = search.query ?? "Read directly";
  const empty = search.sources.length === 0;
  return (
    <li className="flex flex-col">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={empty}
              aria-expanded={empty ? undefined : open}
              onClick={() => setOpen(!open)}
              className={`${ROW} text-muted-foreground hover:bg-foreground/[0.03] focus-visible:ring-accent-brand text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset disabled:hover:bg-transparent`}
            />
          }
        >
          <HugeiconsIcon
            icon={search.query === null ? Link01Icon : Search01Icon}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 tabular-nums">
            {empty ? "No links" : search.sources.length}
          </span>
          {!empty && (
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              className={`size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-sm [overflow-wrap:anywhere]">
          {label}
        </TooltipContent>
      </Tooltip>
      {shown.length > 0 && (
        <ul className="flex flex-col">
          {shown.map((source) => (
            <SourceRow key={source.url} source={source} />
          ))}
        </ul>
      )}
      {open && search.sources.length > SHOWN && (
        // Flush with the rows' icons, its own icon in their column.
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className={`${ROW} text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03] text-left text-xs transition-colors`}
        >
          <HugeiconsIcon
            icon={all ? ArrowUp01Icon : ArrowDown01Icon}
            className="size-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          {all ? "Show less" : `Show all ${search.sources.length}`}
        </button>
      )}
    </li>
  );
}

function SourceRow({ source }: { source: WebSource }) {
  return (
    <li>
      <button
        type="button"
        // The page's own title, when the search gave one, and its address.
        title={source.title ? `${source.title}\n${source.url}` : source.url}
        // Main opens it in the browser, http(s) only, as a chat link.
        onClick={() => void window.desktop?.conversation.openLink(source.url)}
        className={`${ROW} hover:bg-foreground/[0.04] text-left`}
      >
        <LinkIcon host={source.host} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{source.host}</span>
        {source.fetched && (
          <span className="bg-foreground/[0.05] text-muted-foreground shrink-0 rounded px-1.5 py-px text-[11px]">
            Read
          </span>
        )}
      </button>
    </li>
  );
}
