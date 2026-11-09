import { Cancel01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  commitPlan,
  commitScopeLabel,
} from "#/components/shared/repo/commit-plan";
import { Button } from "#/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Kbd } from "#/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#/components/ui/popover";
import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";
import { desktopSurface } from "#/server/desktop";
import { useSession } from "#/stores/session";
import { useWorktree } from "#/stores/worktree";
import type {
  CoAuthorCandidate,
  GitIdentity,
} from "../../../../shared/worktree";

/** A person a `Co-authored-by` trailer names. */
type CoAuthor = Pick<CoAuthorCandidate, "name" | "email">;

/** What the dialog read for one project: the author and who to offer. */
interface People {
  slug: string;
  identity: GitIdentity | null;
  candidates: CoAuthorCandidate[];
}

/**
 * The GitHub login in a `users.noreply.github.com` address, else null.
 *
 * GitHub writes `login@…` for old accounts and `12345+login@…` for new ones.
 */
function githubLogin(email: string): string | null {
  const match = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(
    email.trim(),
  );
  return match ? match[1] : null;
}

/** The commit message: summary, description, then one trailer each. */
function assembleMessage(
  summary: string,
  description: string,
  coAuthors: CoAuthor[],
): string {
  const body = description.trim();
  return (
    summary.trim() +
    (body ? `\n\n${body}` : "") +
    (coAuthors.length
      ? `\n\n${coAuthors
          .map((person) => `Co-authored-by: ${person.name} <${person.email}>`)
          .join("\n")}`
      : "")
  );
}

function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * The author's face: the signed-in account's picture when there is one and
 * it loads (this window's CSP blocks most remote images), initials otherwise.
 */
function AuthorAvatar({
  image,
  name,
  title,
}: {
  image: string | null;
  name: string | null;
  title: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (image && failed !== image)
    return (
      <img
        src={image}
        alt=""
        title={title}
        onError={() => setFailed(image)}
        className="size-6 shrink-0 rounded-full object-cover"
      />
    );
  return (
    <span
      title={title}
      aria-hidden="true"
      className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium select-none"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Commit from anywhere, the way a Git client's commit panel reads: a summary
 * beside the author, a description with co-authors under it, and one button
 * naming the branch.
 *
 * It commits through the worktree store, so the refresh and History reset
 * after a commit are the Git view's own. It takes what {@link commitPlan}
 * says, the same as the Git view's commit box.
 */
export function CommitDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ready = useWorktree((state) =>
    state.slug === slug && state.state?.kind === "ready" ? state.state : null,
  );
  const busy = useWorktree((state) => state.busy);
  const actionError = useWorktree((state) => state.actionError);
  const clearActionError = useWorktree((state) => state.clearActionError);
  const commitChanges = useWorktree((state) => state.commitChanges);
  const owner = useSession((state) =>
    state.session?.principal.kind === "machine"
      ? state.session.principal.owner
      : null,
  );

  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [coAuthors, setCoAuthors] = useState<CoAuthor[]>([]);
  const [people, setPeople] = useState<People | null>(null);
  const [picking, setPicking] = useState(false);

  // Each opening starts from the Git view's box, if it holds a draft: its
  // first line is the summary, the rest the description.
  useEffect(() => {
    if (!open) return;
    const draft = useWorktree.getState().message;
    const cut = draft.indexOf("\n");
    setSummary((cut === -1 ? draft : draft.slice(0, cut)).trim());
    setDescription(cut === -1 ? "" : draft.slice(cut + 1).trim());
    setCoAuthors([]);
  }, [open]);

  // Read once per project and kept: who is committing rarely changes while
  // the app runs.
  const loaded = people?.slug === slug;
  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    const surface = desktopSurface("worktree");
    void Promise.all([
      surface.identity(slug).catch(() => null),
      surface.coAuthors(slug).catch(() => [] as CoAuthorCandidate[]),
    ]).then(([identity, candidates]) => {
      if (live) setPeople({ slug, identity, candidates });
    });
    return () => {
      live = false;
    };
  }, [open, loaded, slug]);

  const plan = commitPlan(ready?.files ?? []);
  const canCommit = ready !== null && plan.scope.length > 0 && busy === null;
  const identity = loaded ? people.identity : null;
  const authorName = identity?.name ?? owner?.name ?? null;
  const authorEmail = identity?.email ?? owner?.email ?? null;
  const authorTitle = authorName
    ? authorEmail
      ? `${authorName} <${authorEmail}>`
      : authorName
    : "No git author set";
  const added = new Set(coAuthors.map((person) => person.email.toLowerCase()));
  const offered = (loaded ? people.candidates : []).filter(
    (person) => !added.has(person.email.toLowerCase()),
  );
  const branch = ready?.branch.name ?? null;

  const submit = async () => {
    if (!canCommit) return;
    const message = assembleMessage(
      summary.trim() || plan.placeholder,
      description,
      coAuthors,
    );
    const done = await commitChanges(plan.mode, plan.placeholder, message);
    if (!done) return;
    setSummary("");
    setDescription("");
    setCoAuthors([]);
    onOpenChange(false);
  };

  const remove = (email: string) =>
    setCoAuthors((list) => list.filter((person) => person.email !== email));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 sm:max-w-md"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Commit</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <AuthorAvatar
            image={owner?.image ?? null}
            name={authorName}
            title={authorTitle}
          />
          <Input
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={plan.placeholder}
            aria-label="Summary"
            autoFocus
            className="h-8"
          />
        </div>

        <div className="border-input bg-input/20 dark:bg-input/30 focus-within:border-ring focus-within:ring-ring/30 flex flex-col rounded-md border transition-colors focus-within:ring-2">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description"
            aria-label="Description"
            rows={5}
            className="placeholder:text-muted-foreground max-h-60 min-h-24 w-full resize-none bg-transparent px-2 pt-2 text-sm outline-none md:text-xs/relaxed"
          />
          <div className="flex items-center px-1 pb-1">
            <Popover open={picking} onOpenChange={setPicking}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add co-author"
                    title="Add co-author"
                    className="text-muted-foreground"
                  />
                }
              >
                <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={1.8} />
              </PopoverTrigger>
              <PopoverContent variant="menu" align="start" className="w-72">
                <Command>
                  <CommandInput placeholder="Search people…" />
                  <CommandList>
                    {loaded ? (
                      <CommandEmpty>Nobody to add.</CommandEmpty>
                    ) : (
                      <div className="flex flex-col gap-2 p-2">
                        <Skeleton className="h-3.5 w-3/4" />
                        <Skeleton className="h-3.5 w-1/2" />
                      </div>
                    )}
                    <CommandGroup>
                      {offered.map((person) => (
                        <CommandItem
                          key={person.email}
                          value={`${person.name} ${person.email}`}
                          onSelect={() => {
                            setCoAuthors((list) => [
                              ...list,
                              { name: person.name, email: person.email },
                            ]);
                            setPicking(false);
                          }}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{person.name}</span>
                            <span className="text-muted-foreground truncate text-[11px]">
                              {person.email}
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          {coAuthors.length > 0 && (
            <div className="border-input flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
              <span className="text-muted-foreground mr-0.5 text-[11px] font-medium">
                Co-Authors
              </span>
              {coAuthors.map((person) => (
                <span
                  key={person.email}
                  title={`${person.name} <${person.email}>`}
                  className="bg-foreground/[0.06] flex h-5 items-center gap-0.5 rounded pl-1.5 text-[11px]"
                >
                  @{githubLogin(person.email) ?? person.name}
                  <button
                    type="button"
                    aria-label={`Remove ${person.name}`}
                    onClick={() => remove(person.email)}
                    onKeyDown={(event) => {
                      if (event.key === "Backspace" || event.key === "Delete") {
                        event.preventDefault();
                        remove(person.email);
                      }
                    }}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 flex size-5 items-center justify-center rounded outline-none focus-visible:ring-2"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      className="size-3"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {actionError && (
          <p
            role="alert"
            className="text-destructive bg-destructive/10 rounded-md px-2.5 py-1.5 text-xs/relaxed break-words whitespace-pre-wrap"
          >
            {actionError}{" "}
            <button
              type="button"
              onClick={clearActionError}
              className="underline underline-offset-2"
            >
              Dismiss
            </button>
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <Button
            className="w-full"
            disabled={!canCommit}
            onClick={() => void submit()}
          >
            {busy === "commit" ? (
              "Committing…"
            ) : (
              <span className="min-w-0 truncate">
                Commit to{" "}
                <span className="font-semibold">
                  {branch ?? "Detached HEAD"}
                </span>
              </span>
            )}
            <Kbd className="ml-1 bg-transparent text-current opacity-70">
              ⌘↩
            </Kbd>
          </Button>
          <span
            className={cn(
              "text-muted-foreground text-center text-[11px]",
              !ready && "invisible",
            )}
          >
            {commitScopeLabel(plan)}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
