export interface Workspace {
  slug: string;
  name: string;
  path: string | null;
  baseBranch: string | null;
}

export interface WorkspaceSnapshot {
  workspaces: Workspace[];
  active: Workspace | null;
}

export const workspaceChannels = {
  load: "workspaces:load",
  select: "workspaces:select",
} as const;

export interface DesktopWorkspacesApi {
  load: () => Promise<WorkspaceSnapshot>;
  select: (slug: string) => Promise<WorkspaceSnapshot>;
}
