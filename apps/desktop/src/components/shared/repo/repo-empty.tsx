import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { buttonVariants } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import type { WorktreeState } from "../../../../shared/worktree";

/**
 * Why there is no repository to show, in the sentence that fixes it.
 *
 * ⚠️ One per `WorktreeState` kind (FE-22/D3). "No folder", "folder gone", "not a
 * repository" and "no git" are four different fixes, and only two of them are
 * in Settings.
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

export function RepoEmpty({
  state,
}: {
  state: Exclude<WorktreeState, { kind: "ready" }>;
}) {
  const { title, description, settings } = copy(state);
  return (
    <RepoMessage title={title} description={description}>
      {settings && (
        <Link
          to="/settings/workspaces"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open Settings
        </Link>
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
