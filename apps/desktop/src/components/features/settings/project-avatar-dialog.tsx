import type { Project } from "#/../shared/projects";
import { AvatarDialog } from "#/components/shared/projects/avatar-dialog";
import { useBoard } from "#/stores/board";

/**
 * Change a project's avatar (FE-162). Saved with the project, so every
 * machine and teammate sees it. "Use default" clears it back to the GitHub
 * icon or the letter tile.
 */
export function ProjectAvatarDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setProjectAvatar = useBoard((state) => state.setProjectAvatar);
  const busy = useBoard((state) => state.busy === `avatar:${project.id}`);
  return (
    <AvatarDialog
      open={open}
      onOpenChange={onOpenChange}
      description={`${project.name} wears it everywhere, on every machine.`}
      name={project.name}
      start={project.avatar ?? null}
      busy={busy}
      disabled={!project.id}
      onSave={async (avatar) => {
        if (!project.id) return null;
        const { error } = await setProjectAvatar(project.id, avatar);
        return error ?? null;
      }}
    />
  );
}
