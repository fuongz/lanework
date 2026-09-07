import { useEffect, useState } from "react";
import {
  SettingsPage,
  SettingsValue,
} from "#/components/shared/settings/settings-page";
import { useSession } from "#/stores/session";
import type { AppInfo } from "../../../../shared/desktop";

/** What the control plane last said, in words rather than a status code. */
const VERDICT_LABEL = {
  ok: "Connected",
  revoked: "Access revoked",
  unreachable: "Cannot reach the control plane",
} as const;

export function AboutSection() {
  const session = useSession((state) => state.session);
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

  const checkedAt = session?.checkedAt
    ? new Date(session.checkedAt).toLocaleTimeString()
    : null;

  return (
    <SettingsPage
      title="About"
      description="This build of Lanework, and where it signs in."
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
          title: "Control plane",
          rows: [
            {
              label: "Signing in against",
              description:
                "Set with LANEWORK_API_URL. Shown here so a connection problem can be told apart from a sign-in problem.",
              keywords: "api origin server url",
              control: <SettingsValue>{session?.apiUrl ?? "—"}</SettingsValue>,
            },
            {
              label: "Status",
              description: checkedAt
                ? `Last checked at ${checkedAt}.`
                : "Checked in the background about once a minute.",
              keywords: "verdict connection online heartbeat",
              control: (
                <SettingsValue>
                  {session?.verdict
                    ? VERDICT_LABEL[session.verdict]
                    : "Not checked yet"}
                </SettingsValue>
              ),
            },
          ],
        },
      ]}
    />
  );
}
