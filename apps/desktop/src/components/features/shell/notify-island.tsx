import { MultiplicationSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import type { IslandRenderContext } from "#/stores/island";
import {
  bindNotifyRenders,
  dismiss,
  hasPanel,
  isSticky,
  press,
  sentence,
  type Toast,
  useNotify,
} from "#/stores/notify";
import { NotifyIcon } from "./notify-island.icons";

// ── The renders ────────────────────────────────────────────────────────────

/**
 * The live toast, or the last one while the island shrinks away, so it
 * leaves still saying what it said rather than going blank first.
 */
function useShownToast(): Toast | null {
  const toast = useNotify((state) => state.toast);
  const last = useRef<Toast | null>(null);
  if (toast) last.current = toast;
  return toast ?? last.current;
}

function Count({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <span className="shrink-0 text-[11.5px] text-white/50 tabular-nums">
      ×{count}
    </span>
  );
}

function Meta({ meta }: { meta?: string }) {
  if (!meta) return null;
  return (
    <span className="ml-auto shrink-0 ps-1 text-[11.5px] text-white/50 tabular-nums">
      {meta}
    </span>
  );
}

/**
 * The folded toast, one line: the status, the title, the count and the meta.
 *
 * With a panel it is a button that opens it. Without one there is nothing to
 * open, and a sticky toast gets a ✕ for the pointer; the keyboard has Escape.
 */
function NotifyPill({ context }: { context: IslandRenderContext }) {
  const toast = useShownToast();
  if (!toast) return null;
  const line = (
    <>
      <NotifyIcon type={toast.type} />
      <span className="truncate">{toast.title}</span>
      <Count count={toast.count} />
      <Meta meta={toast.meta} />
    </>
  );
  const classes =
    "flex h-7 max-w-[min(360px,calc(100vw-48px))] min-w-0 items-center gap-1.5 rounded-[inherit] pl-2 text-[12px] font-medium whitespace-nowrap";
  if (hasPanel(toast))
    return (
      <button
        type="button"
        onClick={() => context.setOpen(true, true)}
        aria-expanded={false}
        aria-label={`${sentence(toast.title)} Show details.`}
        className={cn(
          classes,
          "pr-2.5 outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        {line}
      </button>
    );
  const closable = isSticky(toast) && toast.type !== "loading";
  return (
    <div className={cn(classes, closable ? "pr-1" : "pr-2.5")}>
      {line}
      {closable && (
        <Close
          label="Dismiss notification"
          tabIndex={-1}
          onClick={() => dismiss(toast.id)}
        />
      )}
    </div>
  );
}

/** The open toast: the title, the description, and its buttons. */
function NotifyPanel({ context }: { context: IslandRenderContext }) {
  const toast = useShownToast();
  if (!toast) return null;
  // NOTE: Out of the tab order until the panel is open, as Ding's: a toast
  // that arrived by itself must not catch the next Tab on its way out.
  const tabIndex = context.open ? 0 : -1;
  const { action, secondary } = toast;
  return (
    <section
      aria-label={toast.title}
      className="flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 p-4 pt-3.5 select-text"
    >
      <header className="flex items-start gap-2">
        <NotifyIcon type={toast.type} className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <h2 className="min-w-0 text-[13px] font-semibold tracking-tight break-words">
              {toast.title}
            </h2>
            <Count count={toast.count} />
            <Meta meta={toast.meta} />
          </div>
          {toast.description && (
            // NOTE: Scrolls rather than clamps: an error's description is
            // git's or the tool's own message, and its end is often the part
            // that says what to do.
            <p className="max-h-40 overflow-y-auto text-[12px] break-words whitespace-pre-wrap text-white/70">
              {toast.description}
            </p>
          )}
        </div>
        <Close
          label="Dismiss notification"
          tabIndex={tabIndex}
          onClick={() => dismiss(toast.id)}
          className="-mt-1 -mr-1.5"
        />
      </header>
      {(action || secondary) && (
        <div className="flex justify-end gap-2">
          {secondary && (
            <Button
              tabIndex={tabIndex}
              onClick={() => void press(toast.id, secondary)}
              className="h-7 rounded-full bg-white/[0.14] px-3 text-[12px] text-white hover:bg-white/[0.22] focus-visible:ring-white/40"
            >
              {secondary.label}
            </Button>
          )}
          {action && (
            <Button
              tabIndex={tabIndex}
              onClick={() => void press(toast.id, action)}
              className="h-7 rounded-full bg-white px-3 text-[12px] text-black hover:bg-white/85 focus-visible:ring-white/40"
            >
              {action.label}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function Close({
  label,
  tabIndex,
  onClick,
  className,
}: {
  label: string;
  tabIndex: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      tabIndex={tabIndex}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full text-white/60 hover:bg-white/10 hover:text-white focus-visible:ring-white/40 dark:hover:bg-white/10",
        className,
      )}
    >
      <HugeiconsIcon
        icon={MultiplicationSignIcon}
        className="size-3"
        strokeWidth={2}
        aria-hidden="true"
      />
    </Button>
  );
}

// The store draws the toast through these; bound when the shell loads this
// module, before anything can call `notify`.
bindNotifyRenders({
  pill: (context) => <NotifyPill context={context} />,
  panel: (context) => <NotifyPanel context={context} />,
});

/**
 * The notify toast's place in the shell. It draws nothing itself: the store
 * registers the toast as an island content, and this module's import is what
 * binds its renders.
 */
export function NotifyIsland() {
  return null;
}
