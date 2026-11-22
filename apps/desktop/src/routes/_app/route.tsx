import { createFileRoute } from "@tanstack/react-router";
import { UnsavedFilesGuard } from "#/components/features/repo/unsaved-files-guard";
import { AppShell } from "#/components/features/shell/app-shell";

/** The shell, and the unsaved-files question any screen may need to ask. */
function AppRoot() {
  return (
    <>
      <AppShell />
      <UnsavedFilesGuard />
    </>
  );
}

export const Route = createFileRoute("/_app")({ component: AppRoot });
