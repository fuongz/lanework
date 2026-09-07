import { type ReactNode, useEffect } from "react";
import { StartupLoading } from "#/components/shared/loading/startup-loading";
import { useSession } from "#/stores/session";
import { lockState } from "../../../../shared/policy";
import { SignIn } from "./sign-in";

/**
 * Renders the app only for a session allowed to use it.
 *
 * ⚠️ This is a UX boundary, NOT a security one. It decides what is DRAWN; the
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

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (!ready) return <StartupLoading />;
  if (!session) return <SignIn lock={null} />;

  const lock = lockState(session);
  return lock.locked ? <SignIn lock={lock} /> : children;
}
