import { ThemeChoice } from "#/components/shared/common/theme-choice";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import { Switch } from "#/components/ui/switch";
import { usePreferences } from "#/stores/preferences";
import { CodePreview } from "./code-preview";
import { FontPicker } from "./font-picker";

export function AppearanceSection() {
  const groupProjects = usePreferences((state) => state.groupProjects);
  const setGroupProjects = usePreferences((state) => state.setGroupProjects);
  return (
    <SettingsPage
      title="Appearance"
      description="Theme, fonts and the project list."
      sections={[
        {
          title: "Theme",
          keywords:
            "theme dark light system colour color mode appearance preview",
          // The same control onboarding's second step draws, so a change here
          // cannot leave the first-run screen behind. The preview under it
          // shows the theme and the code font picked below (FE-21/D4a), which
          // is why it sits between the two.
          content: (
            <div className="flex flex-col gap-4">
              <ThemeChoice />
              <CodePreview />
            </div>
          ),
        },
        {
          title: "Fonts",
          rows: [
            {
              label: "UI font",
              keywords: "font typeface family weight interface",
              control: <FontPicker font="ui" label="UI font" />,
            },
            {
              label: "Content font",
              description: "Issues, comments and pull request summaries.",
              keywords: "font typeface family weight markdown body",
              control: <FontPicker font="content" label="Content font" />,
            },
            {
              label: "Code font",
              description: "Terminal, diffs and code blocks.",
              keywords: "font typeface family weight monospace terminal",
              control: <FontPicker font="code" label="Code font" />,
            },
          ],
        },
        {
          title: "Projects",
          rows: [
            {
              label: "Group by namespace",
              description:
                "In the project switcher, projects that share the part of their name before “/” fold under one header.",
              keywords:
                "project switcher group namespace owner organization folder collapse fold",
              control: (
                <Switch
                  aria-label="Group by namespace"
                  checked={groupProjects}
                  onCheckedChange={setGroupProjects}
                />
              ),
            },
          ],
        },
      ]}
    />
  );
}
