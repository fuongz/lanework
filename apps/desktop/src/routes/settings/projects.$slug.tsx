import { createFileRoute } from "@tanstack/react-router";
import { ProjectsSection } from "#/components/features/settings/projects-section";
export const Route = createFileRoute("/settings/projects/$slug")({
  // Keyed by slug: dialogs and notes about one project never carry over to
  // the next one picked in its scope row.
  component: function ProjectPage() {
    const { slug } = Route.useParams();
    return <ProjectsSection key={slug} slug={slug} />;
  },
});
