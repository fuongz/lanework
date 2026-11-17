import {
  Add01Icon,
  ArrowRight01Icon,
  DashboardSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LocalBadge } from "#/components/shared/auth/local-mode";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { CreateProjectDialog } from "#/components/shared/projects/create-project-dialog";
import { ProjectTile } from "#/components/shared/projects/project-tile";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { useBoard } from "#/stores/board";
import { isLocalProject } from "#/stores/session";
import { useFolderPaths } from "./projects-section.folders";

/**
 * Settings › Projects (FE-145): every project of the account, one row each,
 * opening that project's own page.
 *
 * Its folder on this machine under the name, so two projects with one name
 * are told apart where it matters: which checkout an agent will work in.
 */
export function ProjectsList() {
  const navigate = useNavigate();
  const projects = useBoard((state) => state.projects);
  const ready = useBoard((state) => state.ready);
  const hydrate = useBoard((state) => state.hydrate);
  // Settings can be opened straight from a cold start, with nothing loaded.
  useEffect(() => {
    if (!ready) void hydrate();
  }, [ready, hydrate]);
  const { paths } = useFolderPaths(projects);
  const [creating, setCreating] = useState(false);

  const open = (slug: string) =>
    void navigate({ to: "/settings/projects/$slug", params: { slug } });

  const list = !ready ? (
    <ListSkeleton label="Reading projects" rows={4} className="px-0" />
  ) : projects.length === 0 ? (
    <SettingsCard>
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={DashboardSquare02Icon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            A project is a board and the folders its agents work in.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="lg"
            variant="outline"
            className={SETTINGS_BUTTON}
            onClick={() => setCreating(true)}
          >
            <HugeiconsIcon
              icon={Add01Icon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
            />
            New project
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsCard>
  ) : (
    <SettingsCard>
      {projects.map((project) => {
        const folder = paths[project.slug]?.[0];
        return (
          <Link
            key={project.slug}
            to="/settings/projects/$slug"
            params={{ slug: project.slug }}
            // `items-start`: the tile lines up with the name, not the middle
            // of name and folder; the chevron centres itself.
            className="hover:bg-foreground/[0.03] flex items-start gap-3 px-4 py-3.5 transition-colors duration-150 first:rounded-t-xl last:rounded-b-xl"
          >
            <ProjectTile
              project={project}
              className="mt-0.5 size-6 rounded-[6px] text-[11px]"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {project.name}
                </span>
                {isLocalProject(project) && <LocalBadge />}
              </span>
              <span
                className="text-muted-foreground truncate text-[13px]"
                title={folder}
              >
                {folder ?? "No folder on this machine"}
              </span>
            </div>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              className="text-muted-foreground size-4 shrink-0 self-center"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </Link>
        );
      })}
    </SettingsCard>
  );

  return (
    <>
      <SettingsPage
        title="Projects"
        description="Every project on your account and this machine. Open one to rename it, link its folders or check it is ready for agents."
        sections={[
          {
            title: "Projects",
            hideTitle: true,
            // The names too, so the page's search keeps the list while any
            // project matches.
            keywords: `project projects workspace general rename folder folders import readiness sync cloud ${projects.map((project) => project.name).join(" ")}`,
            content: list,
          },
        ]}
      />
      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={open}
      />
    </>
  );
}
