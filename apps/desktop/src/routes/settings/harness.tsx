import { createFileRoute, useParams } from "@tanstack/react-router";
import type { HarnessAgent } from "#/../shared/harness";
import { HarnessSection } from "#/components/features/settings/harness-section";

/**
 * Settings → Harness, and each CLI's page under it (FE-146).
 *
 * NOTE: One component for both, here: `/settings/harness/$cli` only checks
 * its param and draws nothing itself. This route reads it and draws the CLI's
 * page in place of the list, so the section has one importer.
 */
export const Route = createFileRoute("/settings/harness")({
  component: function HarnessPage() {
    const { cli } = useParams({ strict: false }) as { cli?: HarnessAgent };
    return <HarnessSection key={cli ?? "all"} cli={cli} />;
  },
});
