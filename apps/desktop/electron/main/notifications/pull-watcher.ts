// New pull requests on a project's repository. Every two minutes, and when the
// window comes back to the front, read the open list of each project's GitHub
// repo through `gh`. It feeds the rail's count (FE-76) whatever the settings
// say, and notifies for what was not there before when the notification is on
// (FE-76/D3). A rate limit on `gh` pauses the reads for every caller (see
// `git/gh.ts`).
import { app } from "electron";
import { formatRepoRef, type PullsView } from "../../../shared/git";
import { notify } from "./index";
import { observePulls, onNavigate } from "./unseen-pulls";

/** How often the open lists are read (FE-70/D4a). */
const INTERVAL_MS = 2 * 60_000;

/** A focus or a move within this long of the last read does not read again. */
const FOCUS_GAP_MS = 30_000;

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
 *
 * NOTE: Kept up while the notification is off, too. `notify` drops what is
 * off, and switched on later it starts from what is open now rather than
 * announcing everything opened meanwhile.
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
let lastPoll = 0;

async function poll(
  read: () => Promise<{ slug: string; view: PullsView }[]>,
): Promise<void> {
  if (polling) return;
  polling = true;
  lastPoll = Date.now();
  try {
    for (const { slug, view } of await read()) {
      await observePulls(slug, view);
      check(slug, view);
    }
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
  // Back at the window after a while: the count should not wait out the
  // tick (FE-76/D4).
  const soon = () => {
    if (Date.now() - lastPoll >= FOCUS_GAP_MS) void poll(read);
  };
  app.on("browser-window-focus", soon);
  onNavigate(soon);
}
