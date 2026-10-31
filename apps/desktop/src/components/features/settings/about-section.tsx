import { useEffect, useState } from "react";
import {
  SETTINGS_BUTTON,
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import type { AppInfo } from "../../../../shared/desktop";

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

/**
 * The About page: which build this is, and the resource log.
 *
 * No API origin or heartbeat verdict here. Both are the app's own plumbing:
 * the origin comes from an environment variable a user never sets, and the
 * verdict reaches them as what it causes (a board that will not load, a gate
 * that says access was revoked). The origin matters only when a sign-in
 * fails, and `SignIn` prints it there.
 */
export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);

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
      description="This version of Lanework, and what it records about itself."
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
