import { useEffect, useState } from "react";
import {
  NOTIFICATION_DELIVERIES,
  type NotificationDelivery,
  type NotificationKind,
  type NotificationSettings,
} from "#/../shared/notifications";
import {
  SETTINGS_BUTTON,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

const DELIVERY_LABELS: Record<NotificationDelivery, string> = {
  push: "Push",
  off: "Off",
};

function DeliverySelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: NotificationDelivery | null;
  onChange: (value: NotificationDelivery) => void;
}) {
  return (
    <Select
      value={value}
      disabled={value === null}
      onValueChange={(next) => onChange(next as NotificationDelivery)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>
          {(current: NotificationDelivery | null) =>
            current ? DELIVERY_LABELS[current] : ""
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {NOTIFICATION_DELIVERIES.map((delivery) => (
          <SelectItem key={delivery} value={delivery}>
            {DELIVERY_LABELS[delivery]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Sends a test notification now, whatever the rows say.
 *
 * It answers whether this Mac lets Lanework notify at all, the usual reason
 * nothing appears.
 */
function TestButton() {
  return (
    <Button
      size="lg"
      className={`${SETTINGS_BUTTON} self-start`}
      variant="outline"
      onClick={() => void window.desktop?.notifications.test().catch(() => {})}
    >
      Send test
    </Button>
  );
}

/**
 * Settings → Notifications.
 *
 * Main holds the choices, since it is what notifies, with or without a
 * window. So they are read and written there.
 */
export function NotificationsSection() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.desktop?.notifications
      .get()
      .then((value) => {
        if (!disposed) setSettings(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const change = (kind: NotificationKind, delivery: NotificationDelivery) => {
    setSettings((current) => current && { ...current, [kind]: delivery });
    void window.desktop?.notifications
      .set(kind, delivery)
      .then(setSettings)
      .catch(() => {
        // Put back what main still holds.
        void window.desktop?.notifications.get().then(setSettings);
      });
  };

  return (
    <SettingsPage
      title="Notifications"
      description="What Lanework tells you about while you are elsewhere."
      sections={[
        {
          title: "Lanework",
          rows: [
            {
              label: "Agent sessions",
              description: "Get notified when a Claude or Codex run finishes.",
              keywords:
                "agent agents session sessions claude codex run finished done complete",
              control: (
                <DeliverySelect
                  label="Agent sessions notifications"
                  value={settings?.sessions ?? null}
                  onChange={(value) => change("sessions", value)}
                />
              ),
            },
            // An agent stopped on a question or a tool's permission (FE-97).
            {
              label: "Needs your input",
              description:
                "Get notified when Claude or Codex asks a question or needs permission.",
              keywords:
                "input waiting question ask permission approve allow agent claude codex blocked",
              control: (
                <DeliverySelect
                  label="Needs your input notifications"
                  value={settings?.input ?? null}
                  onChange={(value) => change("input", value)}
                />
              ),
            },
            {
              label: "Pull requests",
              description:
                "Get notified when a new pull request is opened on a linked repository.",
              keywords: "pull request pull requests pr prs github new opened",
              control: (
                <DeliverySelect
                  label="Pull request notifications"
                  value={settings?.pulls ?? null}
                  onChange={(value) => change("pulls", value)}
                />
              ),
            },
          ],
        },
        {
          title: "Test",
          hideTitle: true,
          keywords: "test notification try send check permission",
          content: <TestButton />,
        },
      ]}
    />
  );
}
