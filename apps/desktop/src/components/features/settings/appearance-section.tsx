import { SettingsPage } from "#/components/shared/settings/settings-page";
import { Switch } from "#/components/ui/switch";
import { usePreferences } from "#/stores/preferences";
import { AccentPicker } from "./accent-picker";
import { CodePreview } from "./code-preview";
import { FontPicker } from "./font-picker";
import {
  ContentFontPreview,
  TerminalPreview,
  UiFontPreview,
} from "./font-previews";
import { ThemeToggle } from "./theme-toggle";

export function AppearanceSection() {
  const groupProjects = usePreferences((state) => state.groupProjects);
  const setGroupProjects = usePreferences((state) => state.setGroupProjects);
  return (
    <SettingsPage
      title="Appearance"
      description="Theme, accent colour, fonts and the project list."
      sections={[
        {
          // One row each, as the accent's (FE-145): onboarding keeps the
          // large previews; the code preview sits under the fonts it shows.
          title: "Theme",
          rows: [
            {
              label: "Theme",
              description: "Light, dark, or as macOS is set.",
              keywords: "theme dark light system mode appearance",
              control: <ThemeToggle />,
            },
            {
              label: "Accent colour",
              description:
                "Buttons, switches, focus rings, links and selected text.",
              keywords:
                "accent colour color brand primary highlight tint grey gray",
              control: <AccentPicker />,
            },
          ],
        },
        {
          title: "Fonts",
          rows: [
            {
              label: "UI font",
              keywords: "font typeface family weight interface",
              control: <FontPicker font="ui" label="UI font" />,
              preview: <UiFontPreview />,
            },
            {
              label: "Content font",
              description: "Issues, comments and pull request summaries.",
              keywords: "font typeface family weight markdown body",
              control: <FontPicker font="content" label="Content font" />,
              preview: <ContentFontPreview />,
            },
            {
              label: "Code font",
              description: "Terminal, diffs and code blocks.",
              keywords: "font typeface family weight monospace terminal",
              control: <FontPicker font="code" label="Code font" />,
              // Each font's sample under its own row (FE-145).
              preview: (
                <div className="flex flex-col gap-2">
                  <CodePreview />
                  <TerminalPreview />
                </div>
              ),
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
