import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

/** Which step of the first-run flow a screen is, when it is part of one. */
export interface Step {
  index: number;
  count: number;
}

/**
 * The full-window surface every pre-app screen sits on.
 *
 * NOTE: `bg-background` on the view itself. Under macOS vibrancy the body is
 * transparent so the native material shows through, and these screens run
 * before any app chrome exists. Without a surface of their own, near-white
 * text in dark mode sits on whatever is behind the window.
 */
export function OnboardingStage({
  step,
  wide = false,
  children,
}: {
  step?: Step;
  /** Room for three previews side by side, which only the theme step needs. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bg-background relative flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div
        className={cn(
          "flex w-full flex-col items-center text-center",
          // Replayed on every step because the caller re-keys this stage: a
          // hard cut between screens that share a centred column reads as a
          // flicker rather than a move forward.
          "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out",
          // `max-w-2xl` leaves the three theme cards the size Settings draws
          // them at (its column is `max-w-3xl` inside `px-10`), so the control
          // looks the same in both places.
          wide ? "max-w-2xl gap-7" : "max-w-xs gap-6",
        )}
      >
        {children}
      </div>
      {step ? <StepDots {...step} /> : null}
    </div>
  );
}

/**
 * Read-only dots that show where you are in the flow.
 *
 * Not buttons: no step here is worth jumping back to blind, and a dot that
 * looks inert but navigates is a worse affordance than one that reports. The
 * count is spelled out for screen readers, which get nothing from circles.
 */
function StepDots({ index, count }: Step) {
  return (
    <div className="absolute inset-x-0 bottom-10 flex justify-center">
      <p className="sr-only">{`Step ${index + 1} of ${count}`}</p>
      <div aria-hidden className="flex items-center gap-2.5">
        {Array.from({ length: count }, (_, dot) => `step-${dot + 1}`).map(
          (id, dot) => (
            <span
              key={id}
              className={cn(
                "size-1.5 rounded-full transition-colors duration-200 ease-out",
                dot === index ? "bg-foreground" : "bg-foreground/20",
              )}
            />
          ),
        )}
      </div>
    </div>
  );
}
