import { useEffect, useState } from "react";
import type { Workspace } from "#/../shared/workspaces";

/**
 * What main answered this session, by `id|iconKey`, so a tile drawn again —
 * the switcher reopening, another project picked — has its image on the first
 * frame instead of flashing the letter.
 */
const answers = new Map<string, string | null>();

const keyOf = (workspace: Workspace | null) =>
  workspace?.id ? `${workspace.id}|${workspace.iconKey ?? ""}` : null;

/**
 * A project's icon (BE-18) as a `data:` URL, or null for the letter tile —
 * no GitHub repo, not read yet, or a project with no cloud id.
 */
export function useWorkspaceIcon(workspace: Workspace | null): string | null {
  const key = keyOf(workspace);
  const [url, setUrl] = useState(() =>
    key ? (answers.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!key || !workspace?.id) {
      setUrl(null);
      return;
    }
    if (answers.has(key)) {
      setUrl(answers.get(key) ?? null);
      return;
    }
    let live = true;
    const surface = window.desktop?.workspaces;
    if (!surface) return;
    surface
      .icon(workspace.id, workspace.iconKey ?? null)
      .then((answer) => {
        answers.set(key, answer);
        if (live) setUrl(answer);
      })
      .catch(() => {
        // No icon is the honest answer; the letter stays.
      });
    return () => {
      live = false;
    };
  }, [key, workspace?.id, workspace?.iconKey]);

  return url;
}
