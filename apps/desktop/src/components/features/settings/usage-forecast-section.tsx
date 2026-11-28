import { MARGIN_MINUTES } from "#/../shared/usage-forecast";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Switch } from "#/components/ui/switch";
import { usePreferences } from "#/stores/preferences";

const MARGIN_LABELS: Record<(typeof MARGIN_MINUTES)[number], string> = {
  15: "15 minutes",
  30: "30 minutes",
  60: "1 hour",
  120: "2 hours",
};

/**
 * Settings → Usage forecast (FE-181).
 *
 * The choice lives in the renderer's preferences: the island reads it there.
 */
export function UsageForecastSection() {
  const settings = usePreferences((s) => s.usageForecast);
  const setUsageForecast = usePreferences((s) => s.setUsageForecast);
  const off = !settings.enabled;

  return (
    <SettingsPage
      title="Usage forecast"
      description="Get a warning on the island when Claude or Codex is on pace to hit a usage limit before it resets."
      sections={[
        {
          title: "Warnings",
          rows: [
            {
              label: "Warn me before a quota runs out",
              description:
                "Quota is account-wide, so other apps using the same account count too. The forecast needs a few readings before it speaks.",
              keywords:
                "usage quota limit forecast warning island claude codex run out reset",
              control: (
                <Switch
                  aria-label="Warn me before a quota runs out"
                  checked={settings.enabled}
                  onCheckedChange={(enabled) => setUsageForecast({ enabled })}
                />
              ),
            },
            {
              label: "Five-hour window",
              description: "Watch the limit that resets every five hours.",
              keywords: "five hour 5h window session short",
              control: (
                <Switch
                  aria-label="Five-hour window"
                  checked={settings.fiveHour}
                  disabled={off}
                  onCheckedChange={(fiveHour) => setUsageForecast({ fiveHour })}
                />
              ),
            },
            {
              label: "Weekly window",
              description: "Watch the limit that resets every week.",
              keywords: "weekly week window long",
              control: (
                <Switch
                  aria-label="Weekly window"
                  checked={settings.weekly}
                  disabled={off}
                  onCheckedChange={(weekly) => setUsageForecast({ weekly })}
                />
              ),
            },
            {
              label: "Warn when it would run out at least ... before it resets",
              description:
                "A longer margin warns only when you would be out for longer.",
              keywords: "margin minutes hour before reset threshold early",
              control: (
                <Select
                  value={settings.marginMinutes}
                  disabled={off}
                  onValueChange={(next) =>
                    setUsageForecast({ marginMinutes: next as number })
                  }
                >
                  <SelectTrigger aria-label="Warning margin">
                    <SelectValue>
                      {(current: number | null) =>
                        current === null
                          ? ""
                          : (MARGIN_LABELS[
                              current as keyof typeof MARGIN_LABELS
                            ] ?? `${current} minutes`)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MARGIN_MINUTES.map((minutes) => (
                      <SelectItem key={minutes} value={minutes}>
                        {MARGIN_LABELS[minutes]}
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
