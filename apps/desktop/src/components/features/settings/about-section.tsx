import { useEffect, useState } from "react";
import {
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import type { AppInfo } from "../../../../shared/desktop";

/**
 * The About page: which build this is, and nothing else.
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
      description="This version of Lanework."
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
