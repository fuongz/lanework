import {
  GitBranchIcon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  type ReadsRefusal,
  refusalOf,
  type WorktreeState,
} from "../../../../shared/worktree";

/**
 * Why there is no repository to show, in the sentence that fixes it.
 *
 * One per {@link WorktreeState} kind (FE-22/D3). "No folder", "folder gone",
 * "not a repository" and "no git" are four different fixes, and only two of
 * them are in Settings.
 */
function copy(state: Exclude<WorktreeState, { kind: "ready" }>): {
  title: string;
  description: string;
  settings: boolean;
} {
  switch (state.kind) {
    case "none":
      return {
        title: "No folder linked",
        description:
          "Link this project to a folder on this machine to see its changes and history.",
        settings: true,
      };
    case "missing":
      return {
        title: "The folder is gone",
        description: `${state.path} was moved or deleted. Link the folder again where it is now.`,
        settings: true,
      };
    case "not-repo":
      return {
        title: "Not a git repository",
        description: `${state.path} has no git repository. Run git init there, or link a different folder.`,
        settings: true,
      };
    case "no-git":
      return {
        title: "git is not installed",
        description:
          "Install git (on macOS: xcode-select --install), then come back to this window.",
        settings: false,
      };
  }
}

/**
 * Init Git, offered beside Open Settings on a folder that is not a
 * repository (FE-124). Opt-in: only the Files screen passes it.
 */
export interface RepoInitAction {
  /** Runs `git init`; the button is disabled until it settles. */
  onInit: () => void;
  busy: boolean;
  /** Why the last try failed, shown under the buttons; null when it did not. */
  error: string | null;
}

export function RepoEmpty({
  state,
  init,
}: {
  state: Exclude<WorktreeState, { kind: "ready" }>;
  init?: RepoInitAction;
}) {
  const { title, description, settings } = copy(state);
  const canInit = init && state.kind === "not-repo";
  const openSettings = settings && (
    <Link
      to="/settings/projects"
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      Open Settings
    </Link>
  );
  if (!canInit)
    return (
      <RepoMessage title={title} description={description}>
        {openSettings}
      </RepoMessage>
    );
  return (
    <RepoMessage
      title={title}
      description={`${state.path} has no git repository. Initialize one here, or link a different folder.`}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          size="sm"
          disabled={init.busy}
          aria-busy={init.busy}
          onClick={() => {
            if (!init.busy) init.onInit();
          }}
        >
          {init.busy && (
            <HugeiconsIcon
              icon={Loading03Icon}
              className="size-3.5 animate-spin motion-reduce:animate-none"
              strokeWidth={1.5}
              aria-hidden="true"
              data-icon="inline-start"
            />
          )}
          {init.busy ? "Initializing…" : "Init Git"}
        </Button>
        {openSettings}
      </div>
      {init.error && (
        <p
          role="alert"
          className="text-destructive bg-destructive/10 rounded-md px-2.5 py-1.5 text-xs/relaxed break-words whitespace-pre-wrap"
        >
          {init.error}
        </p>
      )}
    </RepoMessage>
  );
}

export function RepoMessage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription className="break-words">
            {description}
          </EmptyDescription>
        </EmptyHeader>
        {children && <EmptyContent>{children}</EmptyContent>}
      </Empty>
    </div>
  );
}

/**
 * The way past a read the git gate held back (FE-102): Ask again when the
 * user said "Don't run", Try again when the check could not run. Nothing for
 * any other error.
 *
 * @param onRetry Asks again (for `refused`), then reads the screen again.
 */
export function HeldReadAction({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: (refusal: ReadsRefusal) => Promise<unknown>;
}) {
  const refusal = refusalOf(message);
  const [busy, setBusy] = useState(false);
  if (!refusal) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onRetry(refusal).finally(() => setBusy(false));
      }}
    >
      <HugeiconsIcon
        icon={RefreshIcon}
        strokeWidth={1.5}
        data-icon="inline-start"
      />
      {refusal === "refused" ? "Ask again" : "Try again"}
    </Button>
  );
}
