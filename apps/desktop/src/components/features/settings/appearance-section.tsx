import { ThemeChoice } from "#/components/shared/common/theme-choice";
import { SettingsPage } from "#/components/shared/settings/settings-page";

export function AppearanceSection() {
  return (
    <SettingsPage
      title="Appearance"
      description="Choose how Lanework looks. Following the system switches with macOS."
      sections={[
        {
          title: "Theme",
          keywords: "theme dark light system colour color mode appearance",
          // The same control onboarding's second step draws, from
          // `shared/common/theme-choice`: one drawing of the three choices,
          // so tweaking it here cannot leave the first-run screen behind.
          content: <ThemeChoice />,
        },
      ]}
    />
  );
}
