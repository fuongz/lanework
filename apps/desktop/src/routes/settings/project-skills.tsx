import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSettingsProjectPick } from "#/stores/settings-project";
export const Route = createFileRoute("/settings/project-skills")({
  // An old address (FE-145): a project's skills are Settings › Skills with
  // that project in the scope row, so leave "All projects" on the way.
  beforeLoad: () => {
    useSettingsProjectPick.getState().setAll(false);
    throw redirect({ to: "/settings/skills", replace: true });
  },
});
