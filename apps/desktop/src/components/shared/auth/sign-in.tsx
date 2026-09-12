import logo from "#/components/shared/common/lanework-logo.png";
import {
  OnboardingStage,
  type Step,
} from "#/components/shared/common/onboarding-stage";
import { Button } from "#/components/ui/button";
import { useSession } from "#/stores/session";
import type { LockState } from "../../../../shared/policy";

/** Only the closed states reach this screen. */
export type Locked = Extract<LockState, { locked: true }>;

/**
 * The last screen of the first-run flow, and the whole of the gate afterwards.
 *
 * `lock` being `null` means there is no desktop bridge at all — nothing to sign
 * in with. `step` is passed only while this is running as part of onboarding;
 * on a later sign-out it stands on its own, with no dots under it.
 */
export function SignIn({ lock, step }: { lock: Locked | null; step?: Step }) {
  const busy = useSession((state) => state.busy);
  const progress = useSession((state) => state.progress);
  const error = useSession((state) => state.error);
  const session = useSession((state) => state.session);
  const signIn = useSession((state) => state.signIn);
  const cancelSignIn = useSession((state) => state.cancelSignIn);

  const heading = busy
    ? "Waiting for your browser"
    : lock === null
      ? "Open Lanework to continue"
      : lock.reason === "revoked"
        ? "This machine's access was revoked"
        : "Sign in to continue";

  const body = busy
    ? "Approve the request in the browser window that just opened. This app is waiting for it."
    : lock === null
      ? "This window is running outside the desktop app, so there is nothing to sign in with."
      : lock.reason === "revoked"
        ? `${lock.machineName || "This machine"} was removed from your account. Signing in again enrols it as a new machine.`
        : "Lanework signs you in through your own browser. Nothing is typed here.";

  return (
    <OnboardingStage step={step}>
      <img
        src={logo}
        alt=""
        className="size-12 select-none"
        draggable={false}
      />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight">
          {heading}
        </h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed text-balance">
          {body}
        </p>
      </div>

      {busy ? (
        <div className="flex w-full flex-col items-center gap-4">
          {/* The wait has a heartbeat. The heading says what to go and do; this
              says the app is still listening while you do it — a screen that
              can sit here for a minute with nothing moving reads as hung. */}
          <div
            role="status"
            className="text-muted-foreground flex items-center gap-2 text-[13px]"
          >
            {/* ⚠️ `startup-loading-spinner` carries the keyframes AND the
                reduced-motion fallback (a static, darker ring) from app.css.
                A bare `animate-spin` here would spin for someone who asked the
                system for no animation. */}
            <span
              aria-hidden
              className="startup-loading-spinner border-foreground/20 border-t-foreground/75 size-3.5 rounded-full border-2"
            />
            Signing in…
          </div>
          {/* Not full width, unlike the button it replaced: the primary action
              is happening in another window, and the way out of it should not
              be the biggest thing on screen. */}
          <Button
            variant="outline"
            size="lg"
            onClick={() => void cancelSignIn()}
          >
            Cancel
          </Button>
          {progress?.mode === "loopback" ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              If no browser opened, copy this link into one:{" "}
              {/* Shown as text rather than a link on purpose: main blocks
                  navigation away from the app origin, so an anchor here would
                  look clickable and do nothing. */}
              <code className="break-all select-all">
                {progress.authorizeUrl}
              </code>
            </p>
          ) : null}
          {progress?.mode === "device" ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Enter this code at{" "}
              <code className="select-all">{progress.verificationUri}</code>:{" "}
              <code className="select-all font-semibold">
                {progress.userCode}
              </code>
            </p>
          ) : null}
        </div>
      ) : lock !== null ? (
        // Full-width and taller than the app's own buttons, like the steps
        // before it: on a screen with exactly one thing to do, the button is
        // the screen rather than a control sitting on it.
        <Button size="lg" className="h-9 w-full" onClick={() => void signIn()}>
          {error ? "Try again" : "Sign in with your browser"}
        </Button>
      ) : null}

      {error ? (
        <div className="flex w-full flex-col gap-2">
          <p
            role="alert"
            className="text-destructive text-xs leading-relaxed break-words"
          >
            {error}
          </p>
          {/* ⚠️ R1 lives HERE now, not under every healthy sign-in. The gate is
              still the only screen someone locked out can reach, so what it was
              talking to has to be readable from it — but that is a question
              nobody asks until it fails, and answering it unprompted was the
              first thing a new user read about the app. */}
          <p className="text-muted-foreground text-xs leading-relaxed break-all">
            Signing in against{" "}
            <code className="select-all">{session?.apiUrl ?? "—"}</code>
          </p>
        </div>
      ) : null}
    </OnboardingStage>
  );
}
