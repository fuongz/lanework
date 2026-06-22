import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  LinkSquare01Icon,
  CircleIcon,
  Flag02Icon,
  UserGroupIcon,
  Calendar03Icon,
  CheckmarkSquare02Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { getCardContent } from "@/server/reviews";
import { useBoardStore } from "@/stores/board-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { progressPercent } from "@/lib/review-stats";
import { STATUS_META } from "@/lib/review-status";
import { formatDate, relativeAge } from "@/lib/format";
import { tagPill } from "@/lib/tag-color";
import { cn } from "@/lib/utils";
import type { ReviewCard, Priority } from "@/lib/github";

interface ReviewDialogProps {
  owner: string;
  repo: string;
  branch: string;
}

export function ReviewDialog({ owner, repo, branch }: ReviewDialogProps) {
  const activeCard = useBoardStore((s) => s.activeCard);
  const closeCard = useBoardStore((s) => s.closeCard);

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCard) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    getCardContent({ data: { owner, repo, path: activeCard.path, ref: branch } })
      .then((md) => {
        if (!cancelled) setContent(md);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load review.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeCard, owner, repo, branch]);

  const githubUrl = activeCard
    ? `https://github.com/${owner}/${repo}/blob/${branch}/${activeCard.path}`
    : "#";

  return (
    <Dialog open={!!activeCard} onOpenChange={(open) => !open && closeCard()}>
      <DialogContent className="flex h-screen max-h-screen w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <div className="mx-auto w-full max-w-3xl">
            <DialogTitle className="pr-8 text-left text-lg">{activeCard?.title}</DialogTitle>
            <DialogDescription className="text-left">
              <a
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {activeCard?.path}
                <HugeiconsIcon icon={LinkSquare01Icon} className="size-3" />
              </a>
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-5">
            {activeCard ? <MetaPanel card={activeCard} /> : null}

            <hr className="my-6 border-border" />

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : content === null ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="mt-6 h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : (
              <article className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</ReactMarkdown>
              </article>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const PRIORITY_STYLE: Record<Priority, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

function MetaPanel({ card }: { card: ReviewCard }) {
  const col = STATUS_META[card.column];
  const pct = progressPercent(card.stats);
  const age = relativeAge(card.date);

  return (
    <div className="flex flex-col">
      <Row icon={CircleIcon} label="Status">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
          <HugeiconsIcon icon={col.icon} className={cn("size-3.5", col.color)} />
          {col.label}
        </span>
      </Row>

      <Row icon={Flag02Icon} label="Priority">
        {card.priority ? (
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium capitalize",
              PRIORITY_STYLE[card.priority],
            )}
          >
            {card.priority}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Row>

      <Row icon={UserGroupIcon} label="Assignees">
        {card.assignees.length > 0 ? (
          card.assignees.map((login) => (
            <span
              key={login}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2.5 pl-0.5 text-xs font-medium"
            >
              <img
                src={`https://github.com/${login}.png?size=40`}
                alt={login}
                className="size-5 rounded-full"
              />
              {login}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        )}
      </Row>

      <Row icon={Calendar03Icon} label="Created">
        <span>
          {formatDate(card.date)}
          {age ? <span className="text-muted-foreground"> ({age})</span> : null}
        </span>
      </Row>

      <Row icon={CheckmarkSquare02Icon} label="Progress">
        {card.stats.total > 0 ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </span>
            <span className="text-muted-foreground">
              {card.stats.done}/{card.stats.total} · {pct}%
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Row>

      <Row icon={Tag01Icon} label="Tags">
        {card.tags.length > 0 ? (
          card.tags.map((tag) => (
            <span
              key={tag}
              className={cn("rounded-full px-2.5 py-1 text-xs font-medium", tagPill(tag))}
            >
              {tag}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">No tags</span>
        )}
      </Row>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: typeof Tag01Icon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-2">
      <div className="flex w-32 shrink-0 items-center gap-2 pt-1 text-sm text-muted-foreground">
        <HugeiconsIcon icon={icon} className="size-4" />
        {label}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">{children}</div>
    </div>
  );
}

/** Remove the leading YAML frontmatter block so it isn't rendered in the body. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}
