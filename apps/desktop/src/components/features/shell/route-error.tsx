import { Alert02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";

/**
 * A screen that could not be drawn, with a way out.
 *
 * NOTE: It may stand in for the whole window (an error above the shell) or
 * for one pane, so it keeps its own drag strip: a window whose only content
 * is this must still move, and the strip clears the traffic lights.
 */
function Fallback({
  icon,
  title,
  description,
  detail,
  actions,
}: {
  icon: typeof Alert02Icon;
  title: string;
  description: string;
  detail?: string;
  actions: ReactNode;
}) {
  return (
    <div className="bg-background text-foreground flex min-h-0 w-full flex-1 flex-col">
      <div className="window-drag-region h-14 shrink-0" aria-hidden="true" />
      <Empty className="flex-1 pb-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={icon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {detail && (
            // The error's own words, selectable, so they can go in a report.
            <pre className="bg-muted text-muted-foreground max-h-32 w-full max-w-md overflow-auto rounded-md px-3 py-2 text-left font-mono text-xs/relaxed whitespace-pre-wrap select-text">
              {detail}
            </pre>
          )}
          <div className="flex gap-2">{actions}</div>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/** The router's error screen, for any route that throws while it renders. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Fallback
      icon={Alert02Icon}
      title="Something went wrong"
      description="This screen hit an error. Go home, or try it again."
      detail={message}
      actions={
        <>
          <Button
            size="sm"
            onClick={() => {
              reset();
              void router.navigate({ to: "/" });
            }}
          >
            Go home
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            Try again
          </Button>
        </>
      }
    />
  );
}

/** The router's screen for a path no route matches. */
export function RouteNotFound() {
  const router = useRouter();
  return (
    <Fallback
      icon={Search01Icon}
      title="Page not found"
      description="Nothing lives at this address in Lanework."
      actions={
        <Button size="sm" onClick={() => void router.navigate({ to: "/" })}>
          Go home
        </Button>
      }
    />
  );
}
