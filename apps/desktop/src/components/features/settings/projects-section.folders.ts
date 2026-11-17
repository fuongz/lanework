import { useCallback, useEffect, useState } from "react";
import type { Project } from "#/../shared/projects";

/**
 * The folders linked to each project on this machine, primary first.
 *
 * NOTE: It hands back the read (`refresh`) as well as the result. Editing a
 * project's folders changes nothing about the project list, so no
 * dependency would change and the page would keep the old paths. A counter in
 * the dependency array would be a dependency the effect does not use.
 */
export function useFolderPaths(projects: Project[]) {
  const [paths, setPaths] = useState<Record<string, string[]>>({});
  // The slugs as one string: a new array every render must not re-read every
  // project's folders.
  const slugs = projects.map((project) => project.slug).join(" ");

  const read = useCallback(async () => {
    const api = window.desktop?.projects.folder;
    if (!api) return;
    const entries = await Promise.all(
      slugs
        .split(" ")
        .filter(Boolean)
        .map(
          async (slug) =>
            // A failed folder read is not worth failing the page over: the row
            // still names the project, and the folder line stays empty.
            [
              slug,
              (await api.list(slug).catch(() => [])).map(
                (folder) => folder.path,
              ),
            ] as const,
        ),
    );
    setPaths(Object.fromEntries(entries));
  }, [slugs]);

  useEffect(() => {
    void read();
  }, [read]);

  return { paths, refresh: read };
}
