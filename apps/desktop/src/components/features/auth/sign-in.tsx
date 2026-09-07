import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import { useSession } from "#/stores/session";
import type { AppInfo } from "../../../../shared/desktop";
import type { LockState } from "../../../../shared/policy";

/** Only the closed states reach this screen. */
export type Locked = Extract<LockState, { locked: true }>;

/** `null` means there is no desktop bridge at all — nothing to sign in with. */
export function SignIn({ lock }: { lock: Locked | null }) {
  const busy = useSession((state) => state.busy);
  const progress = useSession((state) => state.progress);
  const error = useSession((state) => state.error);
  const session = useSession((state) => state.session);
  const signIn = useSession((state) => state.signIn);
  const cancelSignIn = useSession((state) => state.cancelSignIn);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.desktop
      ?.getAppInfo()
      .then((next) => {
        if (!disposed) setInfo(next);
      })
      .catch(() => {
        // The version is context, never a reason to hold up the gate.
      });
    return () => {
      disposed = true;
    };
  }, []);

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
    <div className="flex min-h-screen items-center justify-center px-6 py-14">
      <div className="flex w-full max-w-md flex-col items-start gap-6">
        <div className="flex flex-col items-start gap-3">
          <span className="font-semibold tracking-tight">lanework</span>
          <h1 className="text-3xl font-semibold tracking-tight">{heading}</h1>
          <p className="text-muted-foreground leading-relaxed">{body}</p>
        </div>

        {busy ? (
          <div className="flex w-full flex-col gap-3">
            <Button variant="outline" onClick={() => void cancelSignIn()}>
              Cancel
            </Button>
            {progress?.mode === "loopback" ? (
              <p className="text-muted-foreground text-sm leading-relaxed">
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
              <p className="text-muted-foreground text-sm leading-relaxed">
                Enter this code at{" "}
                <code className="select-all">{progress.verificationUri}</code>:{" "}
                <code className="select-all font-semibold">
                  {progress.userCode}
                </code>
              </p>
            ) : null}
          </div>
        ) : lock !== null ? (
          <Button onClick={() => void signIn()}>
            {error ? "Try again" : "Sign in with your browser"}
          </Button>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="text-destructive text-sm leading-relaxed break-words"
          >
            {error}
          </p>
        ) : null}

        {/* R1: the gate is the only screen available, so it has to carry enough
            for someone to diagnose a control plane they cannot reach. */}
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-sm font-medium">This install</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <Row label="Version" value={info?.version ?? "—"} />
            <Separator />
            <Row label="Signing in against" value={session?.apiUrl ?? "—"} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <code className="break-all select-all">{value}</code>
    </div>
  );
}
