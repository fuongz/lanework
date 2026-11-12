import { useEffect, useState } from "react";
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
import { Switch } from "#/components/ui/switch";
import {
  liveSentence,
  useUpdateActions,
  useUpdaterState,
} from "#/hooks/use-updater";
import type { AppInfo } from "../../../../shared/desktop";
import type { UpdaterLiveWork, UpdaterState } from "../../../../shared/updater";

/**
 * The resource log's switch (FE-115). Off until switched on: it notes this
 * Mac's CPU and memory use, so the person opts in. Main holds the choice,
 * since main is what samples.
 */
function ResourceLogSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.desktop?.metrics
      .get()
      .then((settings) => {
        if (!disposed) setEnabled(settings.enabled);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const change = (next: boolean) => {
    setEnabled(next);
    void window.desktop?.metrics
      .set(next)
      .then((settings) => setEnabled(settings.enabled))
      .catch(() => {
        // Put back what main still holds.
        void window.desktop?.metrics
          .get()
          .then((settings) => setEnabled(settings.enabled));
      });
  };

  return (
    <Switch
      aria-label="Resource log"
      checked={enabled ?? false}
      disabled={enabled === null}
      onCheckedChange={change}
    />
  );
}

/** What the updater is doing, in one sentence, for the Check row. */
function updaterStatus(state: UpdaterState | null): string {
  if (!state) return "Checks GitHub for a newer release of Lanework.";
  switch (state.disabled) {
    case "dev":
      return "This is a development build, and development builds never check for updates.";
    case "unpackaged":
      return "Lanework runs from source here, so it never checks for updates.";
    case "platform":
      return "Updates are published for the macOS build only.";
    default:
      break;
  }
  switch (state.status) {
    case "checking":
      return "Checking GitHub for a newer release.";
    case "available":
      return `Lanework ${state.version ?? ""} is available. Download it when you are ready.`;
    case "downloading":
      return `Downloading Lanework ${state.version ?? ""}${state.progress !== null ? ` (${state.progress}%)` : ""}.`;
    case "ready":
      return state.postponed
        ? `Lanework ${state.version ?? ""} installs the next time you quit.`
        : `Lanework ${state.version ?? ""} is ready to install.`;
    case "up-to-date":
      return "Lanework is up to date.";
    case "error":
      return `The last check failed: ${state.error ?? "no reason given"}`;
    default:
      return "Checks GitHub for a newer release of Lanework.";
  }
}

/**
 * "Check automatically" (INF-11): on by default. It only checks; a newer
 * release downloads when the person asks. Main holds the choice,
 * since main is what checks.
 */
function AutoUpdateSwitch({
  state,
  onChange,
}: {
  state: UpdaterState | null;
  onChange: (next: UpdaterState) => void;
}) {
  const change = (next: boolean) => {
    if (state) onChange({ ...state, auto: next });
    void window.desktop?.updater
      .setAuto(next)
      .then(onChange)
      .catch(() => {
        // Put back what main still holds.
        void window.desktop?.updater.get().then(onChange);
      });
  };
  return (
    <Switch
      aria-label="Check automatically"
      checked={state?.auto ?? false}
      disabled={!state || state.disabled !== null}
      onCheckedChange={change}
    />
  );
}

/**
 * The About page: which build this is, updates, and the resource log.
 *
 * No API origin or heartbeat verdict here. Both are the app's own plumbing:
 * the origin comes from an environment variable a user never sets, and the
 * verdict reaches them as what it causes (a board that will not load, a gate
 * that says access was revoked). The origin matters only when a sign-in
 * fails, and `SignIn` prints it there.
 */
export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [updater, setUpdater] = useUpdaterState();
  const [checking, setChecking] = useState(false);
  const actions = useUpdateActions(updater, setUpdater);
  const busy = checking || updater?.status === "checking";

  const checkNow = () => {
    setChecking(true);
    void window.desktop?.updater
      .check()
      .then(setUpdater)
      .catch(() => {})
      .finally(() => setChecking(false));
  };

  useEffect(() => {
    let disposed = false;
    void window.desktop
      ?.getAppInfo()
      .then((next) => {
        if (!disposed) setInfo(next);
      })
      .catch(() => {
        // The version is context, not something to fail a page over.
      });
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <>
      <RestartConfirm
        live={actions.live}
        busy={actions.busy}
        version={updater?.version ?? ""}
        onRestart={() => void actions.restart()}
        onCancel={actions.cancelRestart}
      />
      <SettingsPage
        title="About"
        description="This version of Lanework, how it updates, and what it records about itself."
        sections={[
          {
            title: "Application",
            rows: [
              {
                label: "Version",
                keywords: "build release",
                control: (
                  <SettingsValue>
                    {info?.version ? `v${info.version}` : "—"}
                  </SettingsValue>
                ),
              },
              {
                label: "Platform",
                keywords: "os system",
                control: <SettingsValue>{info?.platform ?? "—"}</SettingsValue>,
              },
            ],
          },
          {
            title: "Updates",
            rows: [
              {
                label: "Check automatically",
                description:
                  "Check GitHub for a new release when Lanework starts and every 4 hours. Nothing downloads until you choose Download, and you choose when to restart.",
                keywords:
                  "update automatic auto-update upgrade release new version download",
                control: (
                  <AutoUpdateSwitch state={updater} onChange={setUpdater} />
                ),
              },
              {
                label: "Check for updates",
                description: updaterStatus(updater),
                keywords: "update check upgrade release new version latest",
                control: (
                  <UpdateButton
                    state={updater}
                    checking={busy}
                    restarting={actions.busy}
                    onCheck={checkNow}
                    onDownload={actions.download}
                    onRestart={() => void actions.restart()}
                  />
                ),
              },
            ],
          },
          {
            title: "Diagnostics",
            rows: [
              {
                label: "Resource log",
                description:
                  "Record Lanework's CPU and memory use every 30 seconds. The last 24 hours stay on this Mac and are never sent anywhere.",
                keywords:
                  "resource log diagnostics telemetry metrics cpu memory performance usage monitoring",
                control: <ResourceLogSwitch />,
              },
              {
                label: "Log folder",
                description: "Where the resource log keeps its hourly files.",
                keywords: "resource log folder metrics files open finder",
                control: (
                  <Button
                    size="lg"
                    variant="outline"
                    className={SETTINGS_BUTTON}
                    onClick={() =>
                      void window.desktop?.metrics.reveal().catch(() => {})
                    }
                  >
                    Open folder
                  </Button>
                ),
              },
            ],
          },
        ]}
      />
    </>
  );
}

/**
 * The Updates row's one button, for where the update is: Check now, then
 * Download once a release is out, then Restart now once it is downloaded.
 */
function UpdateButton({
  state,
  checking,
  restarting,
  onCheck,
  onDownload,
  onRestart,
}: {
  state: UpdaterState | null;
  checking: boolean;
  restarting: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onRestart: () => void;
}) {
  const off = !state || state.disabled !== null;
  if (!off && state.status === "available")
    return (
      <Button size="lg" className={SETTINGS_BUTTON} onClick={onDownload}>
        Download
      </Button>
    );
  if (!off && state.status === "downloading")
    return (
      <Button size="lg" variant="outline" className={SETTINGS_BUTTON} disabled>
        Downloading…
      </Button>
    );
  if (!off && state.status === "ready")
    return (
      <Button
        size="lg"
        className={SETTINGS_BUTTON}
        disabled={restarting}
        onClick={onRestart}
      >
        {restarting ? "Restarting…" : "Restart now"}
      </Button>
    );
  return (
    <Button
      size="lg"
      variant="outline"
      className={SETTINGS_BUTTON}
      disabled={off || checking}
      onClick={onCheck}
    >
      {checking ? "Checking…" : "Check now"}
    </Button>
  );
}

/** Restart now while terminals or runs are live: ask once more. */
function RestartConfirm({
  live,
  busy,
  version,
  onRestart,
  onCancel,
}: {
  live: UpdaterLiveWork | null;
  busy: boolean;
  version: string;
  onRestart: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={live !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart with work still running?</AlertDialogTitle>
          <AlertDialogDescription>
            {live
              ? `${liveSentence(live)} Restarting Lanework stops ${live.terminals + live.runs === 1 ? "it" : "them"}. Lanework ${version} also installs the next time you quit.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            // `border-0`: without it the popup shows through as a 1px ring
            // (see account-section's Sign out for why it lives here).
            className="border-0"
            disabled={busy}
            onClick={onRestart}
          >
            {busy ? "Restarting…" : "Restart anyway"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
