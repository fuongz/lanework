import { useEffect, useState } from "react";
import {
  LWK_MODES,
  type LwkMode,
  POWER_MINUTES,
  POWER_WARM_CAP_MAX,
  type PowerMinutes,
  type PowerSettings,
} from "#/../shared/conversation";
import { PoweredBy } from "#/components/shared/settings/powered-by";
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

/** 1 to {@link POWER_WARM_CAP_MAX} idle agents kept warm. */
const WARM_CAPS = Array.from({ length: POWER_WARM_CAP_MAX }, (_, i) => i + 1);

const LWK_MODE_LABELS: Record<LwkMode, string> = {
  always: "Always running",
  "on-demand": "On demand",
  "per-call": "Per search",
};

/** One line per mode: what it costs and what it saves (FE-158). */
const LWK_MODE_DESCRIPTIONS: Record<LwkMode, string> = {
  always: "Fastest searches, but lwk keeps its memory while the app runs.",
  "on-demand": "lwk starts on the first search and stops after 5 idle minutes.",
  "per-call": "lwk starts for each search; nothing is kept in memory.",
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
            {
              label: "Idle agents kept running",
              description:
                "Past this many idle agents, the one unused the longest stops, even with End idle chats off. Each one holds a few hundred MB. Conductors and chats set to Keep running don't count.",
              keywords:
                "idle agents warm cap limit max memory ram keep running conductor stop end automatically",
              control: (
                <Select
                  value={settings?.warmCap ?? null}
                  disabled={settings === null}
                  onValueChange={(next) => change({ warmCap: next as number })}
                >
                  <SelectTrigger aria-label="Idle agents kept running">
                    <SelectValue>
                      {(current: number | null) =>
                        current === null ? "" : String(current)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WARM_CAPS.map((count) => (
                      <SelectItem key={count} value={count}>
                        {String(count)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
          ],
        },
        {
          title: "Search",
          rows: [
            {
              label: "Search engine (lwk)",
              description: LWK_MODE_DESCRIPTIONS[settings?.lwkMode ?? "always"],
              byline: <PoweredBy />,
              keywords:
                "lwk lanework-kit search engine kit find grep files code serve process resident memory ram always on demand per search idle powered by lanework",
              control: (
                <Select
                  value={settings?.lwkMode ?? null}
                  disabled={settings === null}
                  onValueChange={(next) => change({ lwkMode: next as LwkMode })}
                >
                  <SelectTrigger aria-label="Search engine (lwk)">
                    <SelectValue>
                      {(current: LwkMode | null) =>
                        current ? LWK_MODE_LABELS[current] : ""
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {LWK_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {LWK_MODE_LABELS[mode]}
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
