import { useEffect, useState } from "react";
import {
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import type { AppInfo } from "../../../../shared/desktop";

/**
 * Which build this is. Nothing else.
 *
 * ⚠️ There used to be a "Control plane" section here — the API origin in force
 * and the heartbeat's last verdict. Both are the app's own plumbing: the origin
 * is set by an environment variable a user never sets, and the verdict already
 * reaches them as the thing it causes (a board that will not load, a gate that
 * says access was revoked) rather than as a line to interpret. The one moment
 * the origin is worth reading is a sign-in that failed, and the gate prints it
 * there — see `SignIn`.
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
      description="This build of Lanework."
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
      ]}
    />
  );
}
