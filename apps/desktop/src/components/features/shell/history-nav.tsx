import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { HistoryLocation } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const indexOf = (location: HistoryLocation): number =>
  location.state?.__TSR_index ?? 0;

/**
 * Back and forward through the window's own history, the way a browser's
 * buttons work.
 *
 * ⚠️ "Can go forward" is not something the History API answers, so it is kept
 * here: the highest entry index seen since the last PUSH. A push drops every
 * entry after it, exactly as the browser does; going back or forward only
 * moves within them. After a reload the entries ahead are unknown, so the
 * forward button starts off until the person goes back once.
 */
function useHistoryNav() {
  const { history } = useRouter();
  const [at, setAt] = useState(() => {
    const index = indexOf(history.location);
    return { index, top: index };
  });
  useEffect(
    () =>
      history.subscribe(({ location, action }) => {
        const index = indexOf(location);
        setAt((prev) => ({
          index,
          top: action.type === "PUSH" ? index : Math.max(prev.top, index),
        }));
      }),
    [history],
  );
  return {
    canBack: at.index > 0,
    canForward: at.index < at.top,
    back: () => history.back(),
    forward: () => history.forward(),
  };
}

const BUTTON =
  "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground grid size-6 place-items-center rounded-md transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40";

export function HistoryButtons() {
  const { canBack, canForward, back, forward } = useHistoryNav();
  return (
    <>
      <button
        type="button"
        onClick={back}
        disabled={!canBack}
        aria-label="Go back"
        title="Go back"
        className={BUTTON}
      >
        <HugeiconsIcon
          icon={ArrowLeft01Icon}
          className="size-4"
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        onClick={forward}
        disabled={!canForward}
        aria-label="Go forward"
        title="Go forward"
        className={BUTTON}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-4"
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </button>
    </>
  );
}
