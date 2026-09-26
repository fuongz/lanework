/**
 * The ring of a 3×3 grid, clockwise from the top-left: the cells the light
 * travels through. The centre is never lit.
 */
const RING = [0, 1, 2, 5, 8, 7, 6, 3];

/**
 * "Working": a light orbiting a 3×3 grid of dots, a fading trail behind it —
 * the Claude CLI's own spinner, drawn in the page rather than as glyphs.
 *
 * ⚠️ Each cell runs the SAME keyframes, offset by a negative delay, so they
 * are all mid-cycle from the first frame: no cell waits its turn to start.
 * Reduced motion stops it on one frame of the orbit (see `app.css`).
 */
export function OrbitSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`orbit-spinner grid size-4 shrink-0 grid-cols-3 grid-rows-3 gap-[2px] p-px ${className}`}
    >
      {Array.from({ length: 9 }, (_, cell) => {
        const step = RING.indexOf(cell);
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed cells
            key={cell}
            className="rounded-[1px] bg-current"
            data-orbit={step === -1 ? undefined : ""}
            style={
              step === -1
                ? { opacity: 0.15 }
                : { animationDelay: `${(step - RING.length) * 100}ms` }
            }
          />
        );
      })}
    </span>
  );
}
