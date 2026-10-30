import { createFileRoute } from "@tanstack/react-router";
import { ProjectLanding } from "#/components/features/projects/project-landing";
export const Route = createFileRoute("/_app/")({ component: ProjectLanding });
