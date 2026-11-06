import { useEffect, useState } from "react";
import {
  POWER_MINUTES,
  type PowerMinutes,
  type PowerSettings,
} from "#/../shared/conversation";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";

const MINUTE_LABELS: Record<PowerMinutes, string> = {
  15: "15 minutes",
  30: "30 minutes",
  60: "1 hour",
  120: "2 hours",
};

/**
 * Settings → Power saver (FE-126).
 *
 * Main holds the choice, since its idle sweep is what ends a chat's engine.
 */
export function PowerSection() {
  const [settings, setSettings] = useState<PowerSettings | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.desktop?.conversation
      .power()
      .then((value) => {
        if (!disposed) setSettings(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const change = (patch: Partial<PowerSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    void window.desktop?.conversation
      .setPower(next)
      .then(setSettings)
      .catch(() => {
        // Put back what main still holds.
        void window.desktop?.conversation.power().then(setSettings);
      });
  };

  return (
    <SettingsPage
      title="Power saver"
      description="Keep your Mac cooler by ending agents that sit idle."
      sections={[
        {
          title: "Idle chats",
          rows: [
            {
              label: "End idle chats",
              description:
                "Stop a chat's agent after it has been idle for a while. Your next message picks the conversation up where it left off.",
              keywords:
                "power saver battery energy idle end stop chat agent engine process claude codex opencode memory cpu heat",
              control: (
                <Switch
                  aria-label="End idle chats"
                  checked={settings?.enabled ?? false}
                  disabled={settings === null}
                  onCheckedChange={(enabled) => change({ enabled })}
                />
              ),
            },
            {
              label: "Idle for",
              description:
                "How long a chat waits before its agent stops. To keep one chat running, right-click it in the sidebar and choose Keep running.",
              keywords: "idle timeout minutes hour duration keep running",
              control: (
                <Select
                  value={settings?.minutes ?? null}
                  disabled={!settings?.enabled}
                  onValueChange={(next) =>
                    change({ minutes: next as PowerMinutes })
                  }
                >
                  <SelectTrigger aria-label="Idle for">
                    <SelectValue>
                      {(current: PowerMinutes | null) =>
                        current ? MINUTE_LABELS[current] : ""
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {POWER_MINUTES.map((minutes) => (
                      <SelectItem key={minutes} value={minutes}>
                        {MINUTE_LABELS[minutes]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
          ],
        },
      ]}
    />
  );
}
