import { createFileRoute, redirect } from "@tanstack/react-router";

const CLIS = ["claude", "codex", "opencode"];

/**
 * One CLI's page in Settings → Harness (FE-146). Drawn by the parent route
 * (`harness.tsx`); this one only turns an unknown CLI back to the list.
 */
export const Route = createFileRoute("/settings/harness/$cli")({
  beforeLoad: ({ params }) => {
    if (!CLIS.includes(params.cli)) throw redirect({ to: "/settings/harness" });
  },
});
