import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { usePulls } from "#/stores/pulls";
import {
  MERGE_METHODS,
  type MergeMethod,
  type PullDetail,
} from "../../../../shared/git";

const methods = {
  merge: {
    title: "Create a merge commit",
    button: "Merge pull request",
    compact: "Merge",
    description: "Add all commits to the base branch with a merge commit.",
  },
  squash: {
    title: "Squash and merge",
    button: "Squash and merge",
    compact: "Squash",
    description: "Combine all commits into one commit on the base branch.",
  },
  rebase: {
    title: "Rebase and merge",
    button: "Rebase and merge",
    compact: "Rebase",
    description: "Rebase each commit and add it to the base branch.",
  },
};

export function mergeDisabledReason(detail: PullDetail): string | null {
  if (detail.pull.state !== "open")
    return "This pull request is already closed.";
  if (detail.pull.draft)
    return "Mark this pull request ready for review before merging.";
  const merge = detail.merge;
  if (!merge)
    return "Merge information is unavailable. Refresh this pull request.";
  if (!merge.canMerge)
    return "Your GitHub account does not have permission to merge here.";
  if (!merge.methods.length)
    return "This repository has no available merge methods.";
  if (merge.mergeable === null || !merge.state || merge.state === "unknown")
    return "GitHub is still calculating mergeability. Refresh to check again.";
  if (!merge.mergeable || merge.state === "dirty")
    return "Resolve conflicts with the base branch before merging.";
  if (merge.state === "blocked")
    return "GitHub branch rules block merging. Check required checks and reviews on GitHub.";
  if (merge.state === "behind")
    return "Update this branch with the base branch before merging.";
  if (!["clean", "unstable", "has_hooks"].includes(merge.state))
    return "GitHub has not confirmed this pull request can be merged. Refresh or check GitHub.";
  return null;
}

export function MergeControl({
  detail,
  compact = false,
}: {
  detail: PullDetail;
  compact?: boolean;
}) {
  const selected = usePulls((state) => state.mergeMethod);
  const select = usePulls((state) => state.selectMergeMethod);
  const busy = usePulls((state) => state.mergeBusy);
  const loading = usePulls((state) => state.detailLoading);
  const error = usePulls((state) => state.mergeError);
  const merge = usePulls((state) => state.mergePull);
  const refresh = usePulls((state) => state.openPull);
  const [confirm, setConfirm] = useState(false);
  const [confirmedHead, setConfirmedHead] = useState(detail.headSha);
  useEffect(() => {
    setConfirmedHead(detail.headSha);
    if (detail.pull.number) setConfirm(false);
  }, [detail.headSha, detail.pull.number]);
  const available = detail.merge?.methods ?? [];
  const method = available.includes(selected)
    ? selected
    : (available[0] ?? selected);
  const reason = mergeDisabledReason(detail);
  if (detail.pull.state !== "open") return null;
  return (
    <div className="window-no-drag flex flex-col gap-2">
      {!compact && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            {reason ?? "No conflicts with base branch"}
          </p>
          {!reason && (
            <p className="text-muted-foreground text-xs">
              GitHub will check branch rules and required checks when merging.
            </p>
          )}
        </div>
      )}
      <fieldset
        aria-label="Merge pull request"
        title={reason ?? undefined}
        className="flex items-center"
      >
        <Button
          size="sm"
          className="rounded-e-none"
          aria-label={busy ? "Merging…" : methods[method].button}
          disabled={busy || loading || !!reason}
          onClick={() => {
            select(method);
            setConfirmedHead(detail.headSha);
            setConfirm(true);
          }}
        >
          {busy ? (
            "Merging…"
          ) : compact ? (
            <>
              <span className="@max-[420px]/pull-detail:hidden">
                {methods[method].button}
              </span>
              <span className="hidden @max-[420px]/pull-detail:inline">
                {methods[method].compact}
              </span>
            </>
          ) : (
            methods[method].button
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="sm" className="rounded-s-none border-s" />}
            disabled={busy || loading || !available.length}
            aria-label="Choose merge method"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={method}
                onValueChange={(value) => select(value as MergeMethod)}
              >
                {MERGE_METHODS.map((value) => (
                  <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    closeOnClick
                    disabled={!available.includes(value)}
                  >
                    <div className="flex flex-col gap-1">
                      <span>{methods[value].title}</span>
                      <span className="text-muted-foreground text-xs">
                        {methods[value].description}
                        {!available.includes(value)
                          ? " Disabled by repository settings."
                          : ""}
                      </span>
                    </div>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </fieldset>
      {!compact && reason && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || loading}
          onClick={() => {
            void refresh(detail.pull.number);
          }}
        >
          Refresh merge status
        </Button>
      )}
      {!compact && error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm {methods[method].button.toLowerCase()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Merge {detail.pull.headRef} into {detail.pull.baseRef} using{" "}
              {methods[method].title.toLowerCase()}? This changes the base
              branch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || loading || !!reason}
              onClick={() => {
                void merge(detail.pull.number, confirmedHead).then((result) => {
                  if (!result.error) setConfirm(false);
                });
              }}
            >
              {busy ? "Merging…" : "Confirm merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
