import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "#/components/features/settings/settings";
export const Route = createFileRoute("/settings")({ component: Settings });
