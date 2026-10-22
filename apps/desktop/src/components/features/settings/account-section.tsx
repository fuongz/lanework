import {
  Copy01Icon,
  Logout01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SignInButton } from "#/components/shared/auth/local-mode";
import { useCopy } from "#/components/shared/common/use-copy";
import {
  SETTINGS_BUTTON,
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { useSession } from "#/stores/session";

/**
 * The Account page: who is signed in, and on which machine.
 *
 * Name and email come from `GET /v1/machines/me`, the one machine route the
 * control plane offers for account display. Editing needs `sessionAuth`,
 * which this app never holds. So the page shows the account, never edits it,
 * and falls back to the id when an older control plane omits the block.
 */
export function AccountSection() {
  const session = useSession((state) => state.session);
  const busy = useSession((state) => state.busy);
  const signOut = useSession((state) => state.signOut);
  const [confirming, setConfirming] = useState(false);
  const [copied, copy] = useCopy();

  /**
   * A value with a button that copies the ID behind it.
   *
   * The account's ID sits beside the email, the machine's beside its name.
   * Support asks for them, and they are too long for a row of their own.
   */
  const withCopy = (
    value: string,
    id: string | null | undefined,
    what: string,
  ) => (
    <div className="flex items-center gap-1">
      <SettingsValue>{value}</SettingsValue>
      {id && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${what}`}
          title={copied === what ? "Copied" : `Copy ${what}`}
          onClick={() => copy(what, id)}
        >
          <HugeiconsIcon
            icon={copied === what ? Tick02Icon : Copy01Icon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );

  const principal = session?.principal;
  const machine = principal?.kind === "machine" ? principal : null;
  const machineName = machine?.name || "this machine";
  const owner = machine?.owner ?? null;
  const error = useSession((state) => state.error);

  // "Skip for now" leaves no account and no machine to show (FE-52/D5, D10).
  // The page becomes the way in instead: a signed-in machine's rows would all
  // read "—", and Sign out would have nothing to revoke.
  if (principal?.kind === "local")
    return (
      <SettingsPage
        title="Account"
        description="Not signed in. Your projects live on this machine only."
        sections={[
          {
            title: "Not signed in",
            rows: [
              {
                label: "Sign in",
                description: "Approve this machine in your browser.",
                keywords: "login sign in account local mode cloud sync",
                control: <SignInButton size="lg" className={SETTINGS_BUTTON} />,
              },
            ],
          },
          ...(error
            ? [
                {
                  title: "Problem",
                  content: (
                    <p
                      role="alert"
                      className="text-destructive text-[13px] break-words"
                    >
                      {error}
                    </p>
                  ),
                },
              ]
            : []),
        ]}
      />
    );

  return (
    <>
      <SettingsPage
        title="Account"
        description="The account this machine is signed in to."
        sections={[
          {
            title: "Signed in",
            rows: [
              {
                label: "Name",
                keywords: "user owner person who",
                control: <SettingsValue>{owner?.name ?? "—"}</SettingsValue>,
              },
              {
                label: "Email",
                keywords: "address user owner account id uuid copy",
                control: withCopy(
                  owner?.email ?? "—",
                  machine?.userId,
                  "account ID",
                ),
              },
              {
                label: "Machine name",
                description: "How your account names this computer.",
                keywords: "hostname computer machine id identifier copy",
                control: withCopy(
                  machine?.name ?? "—",
                  machine?.machineId,
                  "machine ID",
                ),
              },
            ],
          },
          {
            // Drawn as Projects › General draws its own: a red heading
            // over the one irreversible thing on the page.
            title: "Danger zone",
            destructive: true,
            rows: [
              {
                label: "Sign out of this machine",
                description: "Removes this machine from your account.",
                keywords: "logout revoke disconnect remove",
                control: (
                  <Button
                    size="lg"
                    className={`${SETTINGS_BUTTON} border-0`}
                    variant="destructive"
                    // - `border-0`, not a colour override: the base button
                    //   pairs `border border-transparent` with
                    //   `bg-clip-padding`, so the fill stops short of the edge
                    //   and the page shows through as a 1px ring. On a tinted
                    //   pill that reads as a border.
                    // - Optically centred, not geometrically: the icon side
                    //   takes 2px less than the text side, or the glyph looks
                    //   pushed away from its edge.
                    disabled={busy || !machine}
                    onClick={() => setConfirming(true)}
                  >
                    <HugeiconsIcon
                      icon={Logout01Icon}
                      className="size-4"
                      // 2px, not 1.5: the label beside it is `font-medium`.
                      strokeWidth={2}
                    />
                    Sign out
                  </Button>
                ),
              },
            ],
          },
        ]}
      />

      {/* Controlled rather than trigger-driven: signing out is a request to the
          control plane, so the dialog has to stay up until that finishes. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of this machine?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes {machineName} on your lanework account. It is not
              just a log out — signing back in opens your browser and needs a
              fresh approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep this machine
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              // `border-0` for the row button's reason: without it the popup
              // shows through as a 1px ring. It is a property of the registry
              // button, and the next `shadcn add` overwrites `components/ui/`,
              // so the fix belongs at each call site.
              className="border-0"
              disabled={busy}
              onClick={async () => {
                await signOut();
                setConfirming(false);
              }}
            >
              {busy ? "Signing out…" : "Sign out and revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
