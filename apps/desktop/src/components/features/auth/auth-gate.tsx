import { type ReactNode, useEffect, useRef } from "react";
import { Onboarding } from "#/components/features/welcome/onboarding";
import { SignIn } from "#/components/shared/auth/sign-in";
import { StartupLoading } from "#/components/shared/loading/startup-loading";
import { useBoard } from "#/stores/board";
import { usePreferences } from "#/stores/preferences";
import { useSession } from "#/stores/session";
import { lockState } from "../../../../shared/policy";

/**
 * Renders the app only for a session allowed to use it.
 *
 * NOTE: this is a UX boundary, NOT a security one. It decides what is DRAWN; the
 * renderer is a web origin and anything that achieves script execution there
 * gets past it. What decides what can be DONE is `can()` inside the main
 * process — every feature that touches real data must ask there, not rely on
 * this having hidden a button.
 *
 * Placed outside `AppShell` so a locked screen inherits none of the app's
 * chrome: drawing nav for someone who cannot use it is drawing things to bounce
 * off. Routes therefore know nothing about auth, so there is no per-route guard
 * to forget — a deep link to any route lands here first.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const ready = useSession((state) => state.ready);
  const session = useSession((state) => state.session);
  const hydrate = useSession((state) => state.hydrate);
  const hydrated = usePreferences((state) => state.hydrated);
  const onboarded = usePreferences((state) => state.onboarded);
  const completeOnboarding = usePreferences(
    (state) => state.completeOnboarding,
  );

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // A `local` principal ("Skip for now") is an OPEN state, decided by
  // `lockState` like every other — there is no second rule here for it.
  const lock = session ? lockState(session) : null;
  const open = ready && hydrated && lock?.locked === false;

  // FE-52/D6a: signing in from INSIDE the app (local → machine) never passes
  // through the locked screen, so nothing remounts and the project list would
  // keep showing only the local boards. Re-read it when who-we-are changes
  // under an open app; the cloud projects join the local ones there.
  const kind = session?.principal.kind;
  const lastKind = useRef(kind);
  useEffect(() => {
    if (lastKind.current === kind) return;
    const was = lastKind.current;
    lastKind.current = kind;
    if (open && was !== undefined) void useBoard.getState().hydrate();
  }, [kind, open]);

  // NOTE: reaching the app counts as having been onboarded, even for a machine
  // that never walked the flow — a credential seeded from elsewhere, or an
  // install from before this screen existed. Without it, signing out would hand
  // a long-standing user "Welcome to Lanework" as if the app had never met them.
  useEffect(() => {
    if (open && !onboarded) completeOnboarding();
  }, [open, onboarded, completeOnboarding]);

  // NOTE: this waits on the PREFERENCES read too, not just the session. `onboarded`
  // reads false until `localStorage` has been rehydrated, so deciding any
  // earlier flashes the welcome screen at machines that finished with it months
  // ago. Both reads are local and settle in the same beat.
  if (!ready || !hydrated) return <StartupLoading />;
  // No desktop bridge at all: nothing to sign in with, and nothing to onboard.
  if (!lock) return <SignIn lock={null} />;
  if (!lock.locked) return children;

  // Which of the two locked screens this is — the first-run flow or the bare
  // gate — is `Onboarding`'s to decide, and it decides once. Choosing here
  // would mean re-choosing on every render of a flow that changes the flag
  // the choice reads.
  return <Onboarding lock={lock} />;
}
