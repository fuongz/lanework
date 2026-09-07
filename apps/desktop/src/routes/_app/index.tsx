import { createFileRoute } from "@tanstack/react-router";
import { Welcome } from "#/components/features/welcome/welcome";
export const Route = createFileRoute("/_app/")({ component: Welcome });
