import {
  Alert02Icon,
  Calendar03Icon,
  File01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MEMORY_INDEX } from "#/../shared/memory";
import {
  type LinkRenderer,
  MarkdownBody,
} from "#/components/shared/common/markdown-body";
import { MemoryMessage } from "#/components/shared/memory/memory-message";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { relativeTime } from "#/lib/board-view";
import { MEMORY_TYPE_LABELS, memoryLabel, memoryTarget } from "#/lib/memory";
import { cn } from "#/lib/utils";
import { memoryEntry, useMemory } from "#/stores/memory";

const ROUTE = "/_app/w/$slug/memory/$file" as const;

interface Fact {
  key: string;
  label: string;
  icon: IconSvgElement;
  text: string;
  title?: string;
  mono?: boolean;
}

/**
 * The header's second row: its kind, when it changed and its file, each by
 * its icon — the sub-agent viewer's row, for the same reasons.
 */
function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl
      data-testid="memory-meta"
      className="border-sidebar-border text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-6 py-2 text-xs"
    >
      {facts.map((fact) => (
        <div
          key={fact.key}
          title={fact.title ?? fact.label}
          className="flex min-w-0 items-center gap-1.5"
        >
          <dt className="sr-only">{fact.label}</dt>
          <HugeiconsIcon
            icon={fact.icon}
            className="size-3.5 shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <dd className={cn("truncate", fact.mono && "font-mono")}>
            {fact.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One memory, read-only (FE-36): its body as Claude wrote it, without the
 * frontmatter, or the whole file under Raw (D9).
 *
 * ⚠️ Read again whenever the listing says the file changed — main reports
 * every write to the folder (D11) — so what is open is never stale.
 */
export function MemoryDetail() {
  const { slug, file } = useParams({ from: ROUTE });
  const list = useMemory((state) => (state.slug === slug ? state.list : null));
  const opened = useMemory((state) =>
    state.slug === slug ? state.files[file] : undefined,
  );
  const error = useMemory((state) =>
    state.slug === slug ? state.fileErrors[file] : undefined,
  );
  const read = useMemory((state) => state.read);
  const [raw, setRaw] = useState(false);
  const entry = memoryEntry(list, file);
  const stamp = entry ? `${entry.mtimeMs}:${entry.size}` : null;

  useEffect(() => {
    void stamp;
    void read(slug, file);
  }, [read, slug, file, stamp]);

  // Gone from the listing: deleted, or renamed by Claude.
  if (list && !entry)
    return (
      <MemoryMessage
        title="This memory is gone"
        description={`${file} is no longer in this project's memory folder.`}
      />
    );
  if (!opened)
    return error ? (
      <MemoryMessage
        alert
        title="Could not open this memory"
        description={error}
      />
    ) : null;

  const shown = entry ?? opened.entry;
  const index = file === MEMORY_INDEX;
  const title = memoryLabel(shown);
  const now = Date.now();
  const facts: Fact[] = [
    ...(index
      ? []
      : [
          {
            key: "type",
            label: "Kind",
            icon: Tag01Icon,
            text: MEMORY_TYPE_LABELS[shown.type],
          },
        ]),
    {
      key: "modified",
      label: "Changed",
      icon: Calendar03Icon,
      text: relativeTime(shown.modified, now),
      title: new Date(shown.modified).toLocaleString(),
    },
    { key: "file", label: "File", icon: File01Icon, text: file, mono: true },
  ];

  const entries = list?.entries ?? [];
  const link: LinkRenderer = (span) => {
    const target = memoryTarget(span, entries);
    if (target === undefined) return span.raw;
    if (target === null)
      return (
        <span
          title="No memory by this name yet"
          className="text-muted-foreground decoration-muted-foreground/50 underline decoration-dotted underline-offset-2"
        >
          {span.text}
        </span>
      );
    return (
      <Link
        to="/w/$slug/memory/$file"
        params={{ slug, file: target }}
        className="decoration-foreground/30 hover:decoration-foreground underline underline-offset-2 transition-colors"
      >
        {span.text}
      </Link>
    );
  };

  return (
    <section
      aria-label={`Memory — ${title}`}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="window-drag-region border-sidebar-border flex h-11 shrink-0 items-center gap-2 border-b ps-6 pe-4">
        <h1 className="min-w-0 truncate text-[13px] font-medium" title={title}>
          {title}
        </h1>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground ml-auto shrink-0"
          aria-pressed={raw}
          onClick={() => setRaw((value) => !value)}
        >
          Raw
        </Button>
      </header>
      <Facts facts={facts} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full min-w-0 flex-col gap-4 px-6 py-5">
          {opened.truncated && (
            <Alert>
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
              <AlertDescription>
                This memory is longer than one read takes; what is shown is its
                start.
              </AlertDescription>
            </Alert>
          )}
          {raw ? (
            // Wide lines scroll inside the box; the pane never scrolls sideways.
            <pre
              data-testid="memory-raw"
              className="bg-foreground/[0.04] overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre"
            >
              {opened.raw}
            </pre>
          ) : (
            <MarkdownBody
              source={opened.body}
              link={link}
              empty="This memory is empty."
            />
          )}
        </div>
      </div>
    </section>
  );
}
