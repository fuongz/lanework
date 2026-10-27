import { useEffect, useReducer } from "react";

/** How often the ages and countdowns are drawn again. */
const CLOCK_MS = 30_000;

/** Draw again every so often, so ages and countdowns move on their own. */
export function useClock() {
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const timer = setInterval(redraw, CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return Date.now();
}
