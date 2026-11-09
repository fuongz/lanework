import { useEffect, useState } from "react";
import type { ProjectRoots } from "#/../shared/projects";

/** A project with no folder on this machine, or one main could not read. */
const NONE: ProjectRoots = { primary: null, others: [] };

/**
 * A project's folders on this machine: the primary one every engine starts
 * in, and the other existing ones (FE-132).
 *
 * NOTE: Read from main, which resolves them from the folder links it wrote
 * down. Neither the cloud project path (shared by every machine) nor a
 * conversation's `cwd` (the agent's LAST shell directory) says where the
 * checkout is. Never throws: a failed read is "no folder", and sending a
 * message is never blocked on it.
 *
 * @param project The project's key, its cloud id or slug.
 */
export async function readProjectRoots(
  project: string | null | undefined,
): Promise<ProjectRoots> {
  const folder = window.desktop?.projects.folder;
  if (!project || !folder) return NONE;
  try {
    return await folder.roots(project);
  } catch {
    return NONE;
  }
}

/**
 * The same, for drawing: null until the first read answers, then re-read when
 * the project changes. A send reads {@link readProjectRoots} itself, so what
 * it tells the lead never waits on this.
 */
export function useProjectRoots(
  project: string | null | undefined,
): ProjectRoots | null {
  const [roots, setRoots] = useState<{
    project: string;
    value: ProjectRoots;
  } | null>(null);
  useEffect(() => {
    if (!project) return;
    let gone = false;
    void readProjectRoots(project).then((value) => {
      if (!gone) setRoots({ project, value });
    });
    return () => {
      gone = true;
    };
  }, [project]);
  return roots && roots.project === project ? roots.value : null;
}
