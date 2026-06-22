import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  SquareLock01Icon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { getSessionUser } from "@/server/reviews";
import { useRepoStore } from "@/stores/repo-store";
import { AppShell } from "@/components/app-shell";
import { MarketingLanding } from "@/components/marketing/landing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const PAGE_SIZE = 12;

export const Route = createFileRoute("/")({
  loader: async () => ({ user: await getSessionUser() }),
  component: Home,
});

function Home() {
  const { user } = Route.useLoaderData();
  if (!user) return <MarketingLanding />;
  return (
    <AppShell user={user}>
      <ProjectsHome />
    </AppShell>
  );
}

function ProjectsHome() {
  // The full repo list is fetched once into the session store; paginate it client-side.
  const { repos, loading, ensureLoaded } = useRepoStore();
  const [page, setPage] = useState(0);
  useEffect(() => ensureLoaded(), [ensureLoaded]);

  const all = repos ?? [];
  const pageCount = Math.ceil(all.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const visible = all.slice(start, start + PAGE_SIZE);

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

      {loading && !repos ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: PAGE_SIZE }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-none p-10 text-center ring-1 ring-foreground/10">
          <HugeiconsIcon icon={Folder01Icon} className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No repositories found.</p>
        </div>
      ) : (
        <>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((repo, i) => (
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
                    <RepoIcon homepage={repo.homepage} />
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

        {pageCount > 1 && (
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {start + 1}–{Math.min(start + PAGE_SIZE, all.length)} of {all.length}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} data-icon="inline-start" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Next
                <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
              </Button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}

/**
 * Repo icon: the folder icon shows immediately as a placeholder, and the website's
 * favicon (if any) silently replaces it once loaded — so there's no blank gap while
 * the remote image fetches, and the folder stays if there's no site or it errors.
 */
function RepoIcon({ homepage }: { homepage: string | null }) {
  const host = faviconHost(homepage);
  const [loaded, setLoaded] = useState(false);

  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      {!loaded && <HugeiconsIcon icon={Folder01Icon} className="size-4 text-primary" />}
      {host && (
        <img
          src={`https://www.google.com/s2/favicons?sz=64&domain=${host}`}
          alt=""
          width={16}
          height={16}
          onLoad={() => setLoaded(true)}
          className={`size-4 rounded-sm ${loaded ? "block" : "hidden"}`}
        />
      )}
    </span>
  );
}

/** Extract a hostname from a repo homepage, normalizing protocol-less URLs. */
function faviconHost(homepage: string | null): string | null {
  if (!homepage) return null;
  try {
    return new URL(/^https?:\/\//.test(homepage) ? homepage : `https://${homepage}`).hostname;
  } catch {
    return null;
  }
}
