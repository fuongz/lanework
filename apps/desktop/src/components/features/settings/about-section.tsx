import { useEffect, useState } from "react";
import {
  SETTINGS_BUTTON,
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import type { AppInfo } from "../../../../shared/desktop";
import type { UpdaterState } from "../../../../shared/updater";

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

/** The updater's state, kept current from main (INF-11). */
function useUpdaterState(): [
  UpdaterState | null,
  (next: UpdaterState) => void,
] {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => {
    const updater = window.desktop?.updater;
    if (!updater) return;
    let disposed = false;
    const off = updater.onChange((next) => setState(next));
    void updater
      .get()
      .then((next) => {
        if (!disposed) setState(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off();
    };
  }, []);
  return [state, setState];
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
 * "Update automatically" (INF-11): on by default. Main holds the choice,
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
      aria-label="Update automatically"
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
  const busy =
    checking ||
    updater?.status === "checking" ||
    updater?.status === "downloading";

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
              control: <SettingsValue>{info?.version ?? "—"}</SettingsValue>,
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
              label: "Update automatically",
              description:
                "Check GitHub for a new release when Lanework starts and every 4 hours, and download it in the background. You choose when to restart.",
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
                <Button
                  size="lg"
                  variant="outline"
                  className={SETTINGS_BUTTON}
                  disabled={
                    !updater ||
                    updater.disabled !== null ||
                    updater.status === "ready" ||
                    busy
                  }
                  onClick={checkNow}
                >
                  {busy ? "Checking…" : "Check now"}
                </Button>
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
  );
}
