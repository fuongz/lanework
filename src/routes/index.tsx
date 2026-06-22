import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  SquareLock01Icon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { getRepos, getSessionUser } from "@/server/reviews";
import { AppShell } from "@/components/app-shell";
import { MarketingLanding } from "@/components/marketing/landing";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Repo } from "@/lib/github";

export const Route = createFileRoute("/")({
  loader: async () => {
    const user = await getSessionUser();
    if (!user) return { user: null, repos: [] as Repo[] };
    try {
      return { user, repos: await getRepos() };
    } catch {
      return { user, repos: [] as Repo[] };
    }
  },
  component: Home,
});

function Home() {
  const { user, repos } = Route.useLoaderData();
  if (!user) return <MarketingLanding />;
  return (
    <AppShell user={user} repos={repos}>
      <ProjectsHome repos={repos} />
    </AppShell>
  );
}

function ProjectsHome({ repos }: { repos: Repo[] }) {
  return (
    <div className="flex h-full animate-in flex-col overflow-y-auto px-6 py-6 fade-in duration-500 motion-reduce:animate-none">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a repository to open its review board. Repos without a{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">.agents/reviews</code> folder show an
          empty board.
        </p>
      </div>

      {repos.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-none p-10 text-center ring-1 ring-foreground/10">
          <HugeiconsIcon icon={Folder01Icon} className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No repositories found.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo, i) => (
            <motion.div
              key={repo.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: Math.min(i, 12) * 0.04, ease: "easeOut" }}
              whileHover={{ y: -4 }}
            >
              <Link
                to="/board/$owner/$repo"
                params={{ owner: repo.owner, repo: repo.name }}
                className="group block h-full"
              >
                <Card className="h-full transition-[box-shadow,--tw-ring-color] duration-200 group-hover:shadow-md group-hover:ring-foreground/25">
                <CardHeader>
                  <CardTitle className="flex min-w-0 items-center gap-2">
                    <HugeiconsIcon icon={Folder01Icon} className="size-4 shrink-0 text-primary" />
                    <span className="truncate">{repo.name}</span>
                  </CardTitle>
                  <CardDescription className="truncate">{repo.owner}</CardDescription>
                  <CardAction>
                    {repo.private ? (
                      <Badge variant="secondary" className="gap-1">
                        <HugeiconsIcon icon={SquareLock01Icon} className="size-3" />
                        Private
                      </Badge>
                    ) : (
                      <Badge variant="outline">Public</Badge>
                    )}
                  </CardAction>
                </CardHeader>

                {repo.description ? (
                  <CardContent className="line-clamp-2 text-muted-foreground">
                    {repo.description}
                  </CardContent>
                ) : null}

                <CardFooter className="justify-between">
                  <Badge variant="outline" className="gap-1">
                    <HugeiconsIcon icon={GitBranchIcon} className="size-3" />
                    {repo.defaultBranch}
                  </Badge>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                    Open board
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="size-3.5 transition-transform group-hover:translate-x-0.5"
                    />
                  </span>
                </CardFooter>
                </Card>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
