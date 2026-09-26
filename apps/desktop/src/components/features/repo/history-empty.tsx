import { RepoMessage } from "#/components/shared/repo/repo-empty";

/** The right pane of History before a commit is chosen. */
export function HistoryEmpty() {
  return (
    <RepoMessage
      title="No commit open"
      description="Pick one from the list to see what it changed."
    />
  );
}
