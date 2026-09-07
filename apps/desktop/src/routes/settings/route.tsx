import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SettingsShell } from "#/components/features/settings/settings-shell";
export const Route = createFileRoute("/settings")({
  component: () => (
    <SettingsShell>
      <Outlet />
    </SettingsShell>
  ),
});
