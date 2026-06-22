import { AppSidebar, type SidebarNav } from "@/components/app-sidebar";
import type { Repo } from "@/lib/github";

interface AppShellProps {
  user: { name: string; image: string | null };
  repos: Repo[];
  active?: { owner: string; repo: string };
  nav?: SidebarNav;
  children: React.ReactNode;
}

/** Desktop app frame: a rounded panel on a soft background, sidebar + main. */
export function AppShell({ user, repos, active, nav, children }: AppShellProps) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-neutral-200/60 p-2 dark:bg-neutral-900 sm:p-3">
      <div className="flex h-full overflow-hidden rounded-2xl border bg-background shadow-sm">
        <AppSidebar user={user} repos={repos} active={active} nav={nav} />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
