import {
  ArrowRight01Icon,
  GithubIcon,
  RepositoryIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/shared/navigation/select";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { shortAge } from "#/lib/board-view";
import { cn } from "#/lib/utils";
import { usePulls } from "#/stores/pulls";
import {
  formatRepoRef,
  type RepoOption,
  type RepoRef,
} from "../../../../shared/git";

/**
 * Pick the repository a project reads: an owner, then one of its repositories.
 *
 * ⚠️ Two steps rather than one field, because that is the shape of the answer.
 * A person knows which account or organisation the work is under before they
 * know which repo, and splitting it turns a long flat list — every repo from
 * every org they have ever joined — into two short ones.
 *
 * ⚠️ There is no "type the name" escape hatch, and that is deliberate: on a
 * GitHub App, a repository missing from this list is not a spelling problem,
 * it is an ACCESS problem, and typing the name would produce a link that reads
 * as a 404 forever. The way out is GitHub's own configuration page, which is
 * what this screen offers instead.
 */
function Row({
  option,
  onPick,
  busy,
  now,
  hint,
}: {
  option: RepoOption;
  onPick: () => void;
  busy: boolean;
  now: number;
  hint?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        className="hover:bg-foreground/[0.05] focus-visible:ring-accent-brand group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 disabled:opacity-60"
      >
        <HugeiconsIcon
          icon={RepositoryIcon}
          className="text-muted-foreground size-3.5 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {option.repo}
        </span>
        {hint ? (
          <span className="text-accent-brand shrink-0 text-[10px]">{hint}</span>
        ) : option.private ? (
          <span className="text-muted-foreground shrink-0 text-[10px]">
            Private
          </span>
        ) : null}
        <span className="text-muted-foreground w-6 shrink-0 text-right text-[10px] tabular-nums">
          {shortAge(option.pushedAt, now)}
        </span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
    </li>
  );
}

/** The button that leads to the only real fix for a missing repository. */
function ConfigureButton({ owner }: { owner: string | null }) {
  const appAccess = usePulls((state) => state.appAccess);
  const openAppConfig = usePulls((state) => state.openAppConfig);

  // ⚠️ Never hidden. This button used to be gated on "we could list this app's
  // installations", which is false for a classic OAuth App — so it vanished for
  // exactly the person who could not find their repository. Main decides WHICH
  // GitHub page to open; this side only says which owner is on screen.
  const installation =
    appAccess?.installations.find((entry) => entry.account === owner) ?? null;

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void openAppConfig(installation?.id ?? null)}
    >
      <HugeiconsIcon icon={GithubIcon} aria-hidden="true" />
      Configure GitHub App
    </Button>
  );
}

export function RepoPicker({
  suggestion,
  onLink,
}: {
  suggestion: RepoRef | null;
  /**
   * Link the picked `owner/repo` for a project other than the one the pull
   * requests screen has open (FE-55). Defaults to that screen's own link.
   */
  onLink?: (raw: string) => Promise<{ error?: string }>;
}) {
  const options = usePulls((state) => state.repoOptions);
  const loading = usePulls((state) => state.repoOptionsLoading);
  const capped = usePulls((state) => state.repoOptionsCapped);
  const listError = usePulls((state) => state.repoOptionsError);
  const loadRepoOptions = usePulls((state) => state.loadRepoOptions);
  const storeLink = usePulls((state) => state.link);
  const link = onLink ?? storeLink;

  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    void loadRepoOptions();
  }, [loadRepoOptions]);

  // ⚠️ Re-read when the window comes back. The one thing a person leaves this
  // screen to do is grant the app access to more repositories, and returning to
  // the same short list would read as that having failed.
  useEffect(() => {
    const onFocus = () => void loadRepoOptions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadRepoOptions]);

  /**
   * Owners in the order their newest push appears, not by how many repos they
   * have.
   *
   * ⚠️ Recency, because an organisation somebody joined years ago can easily
   * outnumber the account they actually work in — and sorting by count would
   * put the busiest stranger first. The list arrives sorted by push date, so
   * first appearance IS that order.
   */
  const owners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of options ?? [])
      counts.set(row.owner, (counts.get(row.owner) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }, [options]);

  // The folder's own remote decides the default owner when it names one this
  // account can see; otherwise the owner of whatever was pushed most recently.
  const selected =
    owner && owners.some((entry) => entry.name === owner)
      ? owner
      : (owners.find((entry) => entry.name === suggestion?.owner)?.name ??
        options?.[0]?.owner ??
        null);

  const suggested = suggestion ? formatRepoRef(suggestion) : null;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = (options ?? []).filter(
      (row) =>
        row.owner === selected &&
        (!needle || row.repo.toLowerCase().includes(needle)),
    );
    if (!suggested) return rows;
    const index = rows.findIndex((row) => row.fullName === suggested);
    if (index <= 0) return rows;
    return [rows[index], ...rows.filter((_, at) => at !== index)];
  }, [options, query, selected, suggested]);

  async function pick(raw: string) {
    setBusy(true);
    setError(null);
    const result = await link(raw);
    setBusy(false);
    setError(result.error ?? null);
  }

  if (loading && options === null)
    return (
      <p className="text-muted-foreground px-1 py-2 text-xs">
        Reading your repositories…
      </p>
    );

  if (listError)
    return (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-destructive text-xs/relaxed">{listError}</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void loadRepoOptions()}
        >
          Try again
        </Button>
      </div>
    );

  // Nothing at all: on a GitHub App this is the normal first-run state, not a
  // failure, and the fix is one button away.
  if (options !== null && options.length === 0)
    return (
      <Empty className="py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={RepositoryIcon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>No repositories yet</EmptyTitle>
          <EmptyDescription>
            This connection cannot see any. Choose which ones it may read on
            GitHub, then come back — the list refreshes itself.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <ConfigureButton owner={suggestion?.owner ?? null} />
        </EmptyContent>
      </Empty>
    );

  // ⚠️ Fills the panel: the list takes what is left and scrolls on its own,
  // so the owner, the search and "Missing a repository?" stay in view.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Select
        value={selected ?? undefined}
        onValueChange={(value) => {
          setOwner(value);
          // The search belonged to the owner that was open; carrying it into
          // another account would hide everything for no visible reason.
          setQuery("");
        }}
      >
        <SelectTrigger className="w-full" aria-label="Owner">
          <SelectValue placeholder="Owner" />
        </SelectTrigger>
        <SelectContent>
          {owners.map((entry) => (
            <SelectItem key={entry.name} value={entry.name}>
              {entry.name}
              <span className="text-muted-foreground ml-1.5 text-[11px] tabular-nums">
                {entry.count}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search repositories"
          aria-label="Search repositories"
          className="pl-7"
        />
      </div>

      {shown.length > 0 ? (
        <ul
          className={cn(
            "-mx-1 min-h-0 flex-1 overflow-y-auto px-1",
            busy && "pointer-events-none",
          )}
        >
          {shown.map((option) => (
            <Row
              key={option.fullName}
              option={option}
              busy={busy}
              now={now}
              hint={option.fullName === suggested ? "this folder" : undefined}
              onPick={() => void pick(option.fullName)}
            />
          ))}
        </ul>
      ) : (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} />
            </EmptyMedia>
            {/* ⚠️ Names the owner it searched. The list is scoped to one
                account, so "nothing matches" without saying where would read as
                "you do not have that repository". */}
            <EmptyTitle>
              {query.trim()
                ? `Nothing matches “${query.trim()}” in ${selected}.`
                : `No repositories under ${selected}.`}
            </EmptyTitle>
            <EmptyDescription>
              If it is missing, this app has not been given access to it.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <ConfigureButton owner={selected} />
          </EmptyContent>
        </Empty>
      )}

      {capped && (
        <p className="text-muted-foreground px-1 text-[11px]">
          Showing the 300 most recently pushed repositories.
        </p>
      )}

      {error && (
        <p className="text-destructive px-1 text-xs/relaxed">{error}</p>
      )}

      {shown.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2 pt-0.5">
          <span className="text-muted-foreground text-[11px]">
            Missing a repository?
          </span>
          <ConfigureButton owner={selected} />
        </div>
      )}
    </div>
  );
}
