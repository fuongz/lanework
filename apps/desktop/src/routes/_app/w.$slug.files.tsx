import { createFileRoute } from "@tanstack/react-router";
import { FilesLayout } from "#/components/features/repo/files-layout";
export const Route = createFileRoute("/_app/w/$slug/files")({
  component: FilesLayout,
});
