// New pull requests on a project's repository. Every two minutes, while the
// notification is on, read the open list of each project's GitHub repo
// through `gh` and notify for what was not there before. A rate limit on `gh`
// pauses the reads for every caller (see `git/gh.ts`).
import { formatRepoRef, type PullsView } from "../../../shared/git";
import { notificationsOn, notify } from "./index";

/** How often the open lists are read (FE-70/D4a). */
const INTERVAL_MS = 2 * 60_000;

interface RepoWatch {
  /** When this repo was first read. Anything opened before it is old news. */
  since: number;
  /** Ready-for-review pull requests already accounted for. */
  ready: Set<number>;
  /** Drafts seen. One marked ready later is news then (FE-70/D3). */
  drafts: Set<number>;
}

/**
 * What each repo has shown so far, by its lower-cased repo ref.
 *
 * Kept in memory only. The first read of a repo in a run only takes note
 * (FE-70/D4a): what was opened while the app was closed is on the Pull
 * requests screen, and a burst of notifications at launch tells nobody
 * anything.
 */
const watched = new Map<string, RepoWatch>();

function check(slug: string, view: PullsView): void {
  const key = formatRepoRef(view.repo).toLowerCase();
  const seen = watched.get(key);
  if (!seen) {
    watched.set(key, {
      since: Date.now(),
      ready: new Set(
        view.pulls.filter((pull) => !pull.draft).map((pull) => pull.number),
      ),
      drafts: new Set(
        view.pulls.filter((pull) => pull.draft).map((pull) => pull.number),
      ),
    });
    return;
  }
  for (const pull of view.pulls) {
    if (pull.draft) {
      seen.drafts.add(pull.number);
      continue;
    }
    if (seen.ready.has(pull.number)) continue;
    seen.ready.add(pull.number);
    // NOTE: The list is capped at 50, so an old pull request can enter it
    // for the first time when a newer one closes. Its age, not its absence
    // before, says it is not new.
    const fresh =
      Date.parse(pull.createdAt) > seen.since || seen.drafts.has(pull.number);
    seen.drafts.delete(pull.number);
    // What you opened yourself is not news to you (FE-70/D3).
    if (!fresh || pull.authored) continue;
    void notify({
      kind: "pulls",
      title: `New pull request · ${formatRepoRef(view.repo)}`,
      body: `#${pull.number} ${pull.title}${pull.author ? ` — ${pull.author.login}` : ""}`,
      target: { kind: "pull", slug, number: pull.number },
      onScreen: [`/w/${encodeURIComponent(slug)}/issues/pulls`],
    });
  }
}

let timer: NodeJS.Timeout | null = null;
let polling = false;

async function poll(
  read: () => Promise<{ slug: string; view: PullsView }[]>,
): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    if (!(await notificationsOn("pulls"))) {
      // Switched back on later, it starts from a fresh look instead of
      // announcing everything opened while it was off.
      watched.clear();
      return;
    }
    for (const { slug, view } of await read()) check(slug, view);
  } catch {
    // The next tick tries again.
  } finally {
    polling = false;
  }
}

/**
 * Start polling for new pull requests, once per run.
 *
 * @param read Answers each project repo's open pull requests, fresh. It
 *   answers nothing while `gh` is rate limited, missing or signed out.
 */
export function startPullWatcher(
  read: () => Promise<{ slug: string; view: PullsView }[]>,
): void {
  if (timer) return;
  void poll(read);
  timer = setInterval(() => void poll(read), INTERVAL_MS);
  timer.unref();
}
