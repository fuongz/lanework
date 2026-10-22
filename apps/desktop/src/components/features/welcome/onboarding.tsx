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
 * Everything that comes before the app.
 *
 * The first-run walk-through when a machine still needs it, and the sign-in
 * gate on its own when it does not.
 *
 * - The flow runs before sign-in and ends on it: the gate is the last step,
 *   not something waiting on the other side. What it asks for (an appearance)
 *   is a local choice, so a new user meets the app rather than a login form.
 * - There is no way back a step, matching the reference design. The one real
 *   choice on the way is the theme, which Settings and the command menu both
 *   change in a keystroke.
 */
export function Onboarding({ lock }: { lock: Locked }) {
  const onboarded = usePreferences((state) => state.onboarded);
  const completeOnboarding = usePreferences(
    (state) => state.completeOnboarding,
  );

  // NOTE: Read once, at mount, hence the initialiser rather than a plain
  // expression. Reaching the last step ticks `onboarded`, and a flow that
  // re-read it there would decide mid-walk it should never have started and
  // drop the person out of it.
  //
  // A revoked machine was set up here already, so it skips to the gate.
  // Walking it back through "Welcome to Lanework" would be the app pretending
  // not to know that.
  const [start] = useState(() =>
    onboarded || lock.reason !== "signed-out" ? 2 : 0,
  );
  const [index, setIndex] = useState(start);

  // Dots only while this is a flow. A later sign-out reaches the same screen
  // with nothing before it, and three dots there would promise steps that do
  // not exist.
  const step = start === 0 ? { index, count: STEPS } : undefined;

  // Recorded on the way into the last step, not on a successful sign-in. Both
  // questions are answered by then, and someone who quits at the gate should
  // come back to the gate, not the welcome screen.
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
              first thing anyone sees would be a ring around a button nobody
              has reached for. Tab still gets there in one press: it is the
              only focusable thing on the screen. */}
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
          {/* The same control Settings draws. Picking here applies at once, so
              Continue confirms a choice already seen rather than committing an
              unseen one. */}
          <ThemeChoice name="onboarding-theme" />
          <Button size="lg" className="h-9 w-full max-w-xs" onClick={toSignIn}>
            Continue
          </Button>
        </>
      )}
    </OnboardingStage>
  );
}
