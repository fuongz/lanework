import { pullRefsIn, type ToolCall } from "#/../shared/conversation";
import type { PullRef } from "#/../shared/git";
import { PullCard } from "#/components/shared/pulls/pull-card";
import { useIsProjectRepo } from "#/stores/project-pulls";

/**
 * The pull requests a group of commands printed, once each, in order
 * (FE-174): `gh pr create` answers with the new one's URL, `gh pr view` and
 * friends with theirs.
 *
 * NOTE: Only a command's own output is read, never its input: a command that
 * merely mentions a URL did not make or show that pull request.
 */
export function pullsInCalls(calls: readonly ToolCall[]): PullRef[] {
  const found = new Map<string, PullRef>();
  for (const call of calls) {
    if (call.kind !== "command" || call.error || !call.output) continue;
    for (const ref of pullRefsIn(call.output)) {
      const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
      if (!found.has(key)) found.set(key, ref);
    }
  }
  return [...found.values()];
}

/**
 * A pull request a command printed, as a card under the commands, when it
 * is one of this project's; nothing for another repository's.
 */
export function ToolPullCard({ slug, pull }: { slug: string; pull: PullRef }) {
  const ours = useIsProjectRepo(slug, pull);
  return ours ? <PullCard slug={slug} number={pull.number} /> : null;
}
