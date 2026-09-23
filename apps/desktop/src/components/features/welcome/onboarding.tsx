import { useState } from "react";
import { type Locked, SignIn } from "#/components/shared/auth/sign-in";
import logo from "#/components/shared/common/lanework-logo.png";
import { OnboardingStage } from "#/components/shared/common/onboarding-stage";
import { ThemeChoice } from "#/components/shared/common/theme-choice";
import { Button } from "#/components/ui/button";
import { usePreferences } from "#/stores/preferences";

/** Welcome, then appearance, then the sign-in gate itself. */
const STEPS = 3;

/**
 * Everything that comes before the app: the first-run walk-through when a
 * machine still needs it, and the sign-in gate on its own when it does not.
 *
 * ⚠️ The flow runs BEFORE sign-in and ends ON it — the gate is the last step,
 * not something waiting on the other side. What it asks for (an appearance) is
 * a local choice, so nothing here needs an account first, and a new user meets
 * the app rather than a login form.
 *
 * There is no way back a step, matching the reference: the one real choice on
 * the way through is the theme, which Settings and the command menu both change
 * in a keystroke.
 */
export function Onboarding({ lock }: { lock: Locked }) {
  const onboarded = usePreferences((state) => state.onboarded);
  const completeOnboarding = usePreferences(
    (state) => state.completeOnboarding,
  );

  // ⚠️ Read ONCE, at mount, and never again — hence the initialiser rather than
  // a plain expression. Reaching the last step ticks `onboarded`, and a flow
  // that re-read it there would decide mid-walk that it should never have
  // started and drop the person straight out of it.
  //
  // A REVOKED machine was plainly set up here already, so it skips to the gate:
  // walking it back through "Welcome to Lanework" to re-enrol would be the app
  // pretending not to know that.
  const [start] = useState(() =>
    onboarded || lock.reason !== "signed-out" ? 2 : 0,
  );
  const [index, setIndex] = useState(start);

  // Dots only while this actually IS a flow. A later sign-out reaches the same
  // screen with nothing before it, and three dots there would promise steps
  // that do not exist.
  const step = start === 0 ? { index, count: STEPS } : undefined;

  // Recorded on the way INTO the last step, not on a successful sign-in: both
  // questions have been answered by then, and someone who quits at the gate
  // should come back to the gate rather than to the welcome screen again.
  const toSignIn = () => {
    completeOnboarding();
    setIndex(2);
  };

  if (index === 2) return <SignIn lock={lock} step={step} />;

  return (
    <OnboardingStage key={index} step={step} wide={index === 1}>
      {index === 0 ? (
        <>
          <img
            src={logo}
            alt=""
            className="size-14 select-none"
            draggable={false}
          />
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight">
              Welcome to Lanework
            </h1>
            <p className="text-muted-foreground text-[13px] leading-relaxed text-balance">
              Lanework turns the review cards your coding agents write into a
              board you can work from.
            </p>
          </div>
          {/* No `autoFocus`: it lands as `:focus-visible` in Electron, so the
              very first thing anyone sees would be a ring around a button
              nobody has reached for yet. Tab still gets there in one press —
              it is the only focusable thing on the screen. */}
          <Button size="lg" className="h-9 w-full" onClick={() => setIndex(1)}>
            Get started
          </Button>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight">
              Choose your style
            </h1>
            <p className="text-muted-foreground text-[13px] leading-relaxed text-balance">
              You can change this at any time in Settings, or from the command
              menu.
            </p>
          </div>
          {/* The same control Settings draws. Picking here applies immediately —
              the window changes under the cursor — so Continue confirms a choice
              already made rather than committing an unseen one. */}
          <ThemeChoice name="onboarding-theme" />
          <Button size="lg" className="h-9 w-full max-w-xs" onClick={toSignIn}>
            Continue
          </Button>
        </>
      )}
    </OnboardingStage>
  );
}
