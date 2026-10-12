import { Logout01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SignInButton } from "#/components/shared/auth/local-mode";
import {
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
 * Who is signed in, and on which machine.
 *
 * ⚠️ Name and email come from `GET /v1/machines/me` — the ONE machine route the
 * control plane uses for account display. Editing is `sessionAuth`, which this
 * app never holds; workspace discovery uses `/v1/sync/state`. So this page shows
 * the account, never edits it, and falls back to the id when an older control
 * plane does not send the block.
 */
export function AccountSection() {
  const session = useSession((state) => state.session);
  const busy = useSession((state) => state.busy);
  const signOut = useSession((state) => state.signOut);
  const [confirming, setConfirming] = useState(false);

  const principal = session?.principal;
  const machine = principal?.kind === "machine" ? principal : null;
  const machineName = machine?.name || "this machine";
  const owner = machine?.owner ?? null;
  const error = useSession((state) => state.error);

  // FE-52/D5 + D10: "Skip for now" leaves no account and no machine to show.
  // The page becomes the way in instead — the rows a signed-in machine has
  // would all read "—", and Sign out would have nothing to revoke.
  if (principal?.kind === "local")
    return (
      <SettingsPage
        title="Account"
        description="Lanework is running on this machine only. Sign in to keep your projects on a lanework account."
        sections={[
          {
            title: "Not signed in",
            rows: [
              {
                label: "Sign in",
                description:
                  "Opens your browser to approve this machine. Projects made here stay on this machine until you sync each one to the account.",
                keywords: "login sign in account local mode cloud sync",
                control: (
                  <SignInButton size="lg" className="h-8 px-3 text-sm" />
                ),
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
        description="The lanework account this machine is enrolled in."
        sections={[
          {
            title: "Signed in",
            rows: [
              {
                label: "Name",
                description: "From your lanework account.",
                keywords: "user owner person who",
                control: <SettingsValue>{owner?.name ?? "—"}</SettingsValue>,
              },
              {
                label: "Email",
                keywords: "address user owner",
                control: <SettingsValue>{owner?.email ?? "—"}</SettingsValue>,
              },
              {
                label: "Account ID",
                description:
                  "Shown because everything on the account keys on it, and because an older control plane sends nothing else.",
                keywords: "user id uuid",
                control: (
                  <SettingsValue>{machine?.userId ?? "—"}</SettingsValue>
                ),
              },
              {
                label: "Machine name",
                description: "What your account lists this computer as.",
                keywords: "hostname computer",
                control: <SettingsValue>{machine?.name ?? "—"}</SettingsValue>,
              },
              {
                label: "Machine ID",
                description:
                  "Identifies this install. Everything on your account keys on it, never on the name.",
                keywords: "credential identifier",
                control: (
                  <SettingsValue>{machine?.machineId ?? "—"}</SettingsValue>
                ),
              },
            ],
          },
          {
            title: "Sign out",
            rows: [
              {
                label: "Sign out of this machine",
                description:
                  "Revokes this machine on your account. Signing back in opens your browser and needs a fresh approval.",
                keywords: "logout revoke disconnect remove",
                control: (
                  <Button
                    variant="destructive"
                    size="lg"
                    // `border-0`, not a colour override: the base button pairs
                    // `border border-transparent` with `bg-clip-padding`, so the
                    // fill stops short of the edge and the page shows through as
                    // a 1px ring. On a tinted pill that reads as a border.
                    // Optically, not geometrically centred: the icon side takes
                    // 2px less than the text side, or the glyph reads as pushed
                    // away from the edge it sits against.
                    className="h-8 gap-1.5 rounded-lg border-0 pr-3 pl-2.5 text-sm"
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
              // Same `border-0` as the row button, and the same reason: the base
              // button pairs `border border-transparent` with `bg-clip-padding`,
              // so the fill stops short of the edge and the popup shows through
              // as a 1px ring. Third call site this has caught — it is a
              // property of the registry button, and `components/ui/` is
              // overwritten by the next `shadcn add`, so the fix belongs here.
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
