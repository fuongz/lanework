import {
  Alert02Icon,
  Copy01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { useCopy } from "#/hooks/use-copy";

/**
 * A screen that could not be drawn, with a way out.
 *
 * - A soft glow and a fading dot grid behind a floating mark: something
 *   broke, said calmly. The float stops under reduced motion.
 * - The error's own words sit in a console-like card with Copy, so they go
 *   into a report as they are.
 * - NOTE: It may stand in for the whole window (an error above the shell)
 *   or for one pane. As the window's only content it fills the window's
 *   height; in a pane it takes the pane's. It keeps its own drag strip: a
 *   window whose only content is this must still move.
 */
function Fallback({
  icon,
  title,
  description,
  detail,
  backdrop,
  actions,
}: {
  icon: typeof Alert02Icon;
  title: string;
  description: string;
  detail?: string;
  /** A large, faint word behind the mark, e.g. 404. */
  backdrop?: string;
  actions: ReactNode;
}) {
  const [copied, copy] = useCopy();
  return (
    <div className="bg-background text-foreground relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden [body>*>&]:min-h-dvh [body>&]:min-h-dvh">
      {/* The glow and the grid, behind everything. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_38%,color-mix(in_oklab,var(--accent-brand)_14%,transparent),transparent_60%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_at_50%_40%,black,transparent_70%)] bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_12%,transparent)_1px,transparent_1px)] [background-size:18px_18px]"
      />
      <div className="window-drag-region h-14 shrink-0" aria-hidden="true" />
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-20">
        <div className="relative flex flex-col items-center">
          {backdrop && (
            <span
              aria-hidden="true"
              className="text-foreground/[0.05] pointer-events-none absolute -top-16 text-[140px] leading-none font-bold tracking-tighter tabular-nums select-none"
            >
              {backdrop}
            </span>
          )}
          <span className="bg-card ring-border/80 relative grid size-14 place-items-center rounded-2xl shadow-sm ring-1 motion-safe:animate-[float_4s_ease-in-out_infinite]">
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-2xl bg-[linear-gradient(160deg,color-mix(in_oklab,var(--accent-brand)_16%,transparent),transparent_55%)]"
            />
            <HugeiconsIcon
              icon={icon}
              className="text-accent-brand relative size-6"
              strokeWidth={1.6}
              aria-hidden="true"
            />
          </span>
        </div>
        <h1 className="mt-6 text-xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        <p className="text-muted-foreground mt-1.5 max-w-sm text-center text-sm text-balance">
          {description}
        </p>
        {detail && (
          <figure className="bg-card ring-border/80 mt-6 w-full max-w-lg overflow-hidden rounded-xl text-left shadow-xs ring-1">
            <figcaption className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 text-[11px] font-medium">
              <span className="bg-destructive size-1.5 rounded-full" />
              <span className="flex-1">Error</span>
              <button
                type="button"
                onClick={() => copy("error", detail)}
                className="hover:text-foreground hover:bg-foreground/[0.05] flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
              >
                <HugeiconsIcon
                  icon={copied ? Tick02Icon : Copy01Icon}
                  className="size-3"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                {copied ? "Copied" : "Copy"}
              </button>
            </figcaption>
            {/* The error's own words, selectable, so they can go in a report. */}
            <pre className="text-foreground/80 max-h-40 overflow-auto px-3 py-2.5 font-mono text-xs/relaxed whitespace-pre-wrap select-text">
              {detail}
            </pre>
          </figure>
        )}
        <div className="mt-6 flex gap-2">{actions}</div>
      </div>
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
      description="This screen tripped over an error. Try it again, or head home."
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
      backdrop="404"
      actions={
        <Button size="sm" onClick={() => void router.navigate({ to: "/" })}>
          Go home
        </Button>
      }
    />
  );
}
