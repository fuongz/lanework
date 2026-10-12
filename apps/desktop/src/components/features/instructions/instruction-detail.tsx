import {
  Alert02Icon,
  Calendar03Icon,
  File01Icon,
  Folder01Icon,
  Layers01Icon,
  Target02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  type LinkRenderer,
  MarkdownBody,
} from "#/components/shared/common/markdown-body";
import { InstructionsMessage } from "#/components/shared/instructions/instructions-message";
import { useSettingsProject } from "#/components/shared/settings/project-picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { relativeTime } from "#/lib/board-view";
import {
  AGENT_LABELS,
  appearances,
  fileSize,
  importOf,
  linkImports,
  SCOPE_LABELS,
} from "#/lib/instructions";
import { shortPath } from "#/lib/memory";
import { cn } from "#/lib/utils";
import { useInstructions } from "#/stores/instructions";

const ROUTE = "/settings/instructions/$id" as const;

interface Fact {
  key: string;
  label: string;
  icon: IconSvgElement;
  text: string;
  title?: string;
  mono?: boolean;
}

/** The header's second row — Memory's, for the same reasons. */
function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl
      data-testid="instruction-meta"
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
 * One instruction file, read-only (FE-37): what the agent reads of it, its
 * `@imports` as links to the files they name, or the whole file under Raw.
 *
 * ⚠️ Read again whenever the listing says the file changed — main reports
 * writes to the folders it lives in (D7) — so what is open is never stale.
 */
export function InstructionDetail() {
  const { id } = useParams({ from: ROUTE });
  const slug = useSettingsProject();
  const list = useInstructions((state) =>
    state.slug === slug ? state.list : null,
  );
  const opened = useInstructions((state) =>
    state.slug === slug ? state.files[id] : undefined,
  );
  const error = useInstructions((state) =>
    state.slug === slug ? state.fileErrors[id] : undefined,
  );
  const read = useInstructions((state) => state.read);
  const reveal = useInstructions((state) => state.reveal);
  const [raw, setRaw] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const file = list?.files[id];
  const stamp = file ? `${file.mtimeMs}:${file.size}` : null;

  useEffect(() => {
    void stamp;
    void read(slug, id);
  }, [read, slug, id, stamp]);

  if (list && !file)
    return (
      <InstructionsMessage
        title="This file is no longer read"
        description="Neither agent reads it for this project any more."
      />
    );
  if (!opened)
    return error ? (
      <InstructionsMessage
        alert
        title="Could not open this file"
        description={error}
      />
    ) : null;

  const shown = file ?? opened.file;
  const title = shown.name === shown.path ? shortPath(shown.path) : shown.name;
  const seen = list ? appearances(list, id) : [];
  const readBy = [
    ...new Set(
      seen.map(({ agent, node }) =>
        agent === "nested"
          ? node.agents.map((who) => AGENT_LABELS[who]).join(" and ")
          : `${AGENT_LABELS[agent]} (${SCOPE_LABELS[node.scope]})`,
      ),
    ),
  ];
  const notes = [
    ...new Set(seen.map(({ node }) => node.note).filter(Boolean)),
  ] as string[];
  const now = Date.now();
  const facts: Fact[] = [
    ...(readBy.length
      ? [
          {
            key: "read-by",
            label: "Read by",
            icon: Layers01Icon,
            text: readBy.join(", "),
          },
        ]
      : []),
    ...(opened.paths.length
      ? [
          {
            key: "paths",
            label: "Applies to",
            icon: Target02Icon,
            text: opened.paths.join(", "),
            mono: true,
          },
        ]
      : []),
    {
      key: "changed",
      label: "Changed",
      icon: Calendar03Icon,
      text: relativeTime(new Date(shown.mtimeMs).toISOString(), now),
      title: new Date(shown.mtimeMs).toLocaleString(),
    },
    {
      key: "file",
      label: "File",
      icon: File01Icon,
      text: `${shortPath(shown.path)} (${fileSize(opened.file.size)})`,
      title: shown.path,
      mono: true,
    },
  ];

  const link: LinkRenderer = (span) => {
    const target = importOf(span.href, opened.imports);
    // Any other link in the file stays exactly as written.
    if (!target) return span.raw;
    const to = target.file ? list?.files[target.file] : undefined;
    // An `@word` that names no file is a mention, not an import.
    if (!to) return span.text;
    if (to.missing || !to.markdown)
      return (
        <span
          title={
            to.missing
              ? "No file here: nothing loads"
              : `${shortPath(to.path)} — only Markdown is shown`
          }
          className="text-muted-foreground decoration-muted-foreground/50 underline decoration-dotted underline-offset-2"
        >
          {span.text}
        </span>
      );
    return (
      <Link
        to="/settings/instructions/$id"
        params={{ id: to.id }}
        search={{ project: slug }}
        className="decoration-foreground/30 hover:decoration-foreground underline underline-offset-2 transition-colors"
      >
        {span.text}
      </Link>
    );
  };

  return (
    <section
      aria-label={`Instructions — ${title}`}
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label="Reveal in Finder"
          title={`Reveal in Finder — ${shortPath(shown.path)}`}
          onClick={() => {
            setRevealError(null);
            reveal(slug, id).catch((failed: unknown) =>
              setRevealError(
                failed instanceof Error
                  ? failed.message
                  : "Could not show this file in Finder.",
              ),
            );
          }}
        >
          <HugeiconsIcon
            icon={Folder01Icon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
      </header>
      <Facts facts={facts} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full min-w-0 flex-col gap-4 px-6 py-5">
          {revealError && (
            <p role="alert" className="text-destructive text-xs">
              {revealError}
            </p>
          )}
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground text-xs">
              {note}
            </p>
          ))}
          {opened.truncated && (
            <Alert>
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
              <AlertDescription>
                This file is longer than one read takes; what is shown is its
                start.
              </AlertDescription>
            </Alert>
          )}
          {raw ? (
            // Wide lines scroll inside the box; the pane never scrolls sideways.
            <pre
              data-testid="instruction-raw"
              className="bg-foreground/[0.04] overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre"
            >
              {opened.raw}
            </pre>
          ) : (
            <MarkdownBody
              source={linkImports(opened.body)}
              link={link}
              empty="This file is empty."
            />
          )}
        </div>
      </div>
    </section>
  );
}
