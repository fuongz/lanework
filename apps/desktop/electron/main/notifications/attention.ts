// What needs the person (FE-136/D4, D6): one `runs` notification when a run
// gets its report, and an attention count shown on the dock badge and as a
// list in the menu bar. The count is workers waiting on input, plus proposals
// awaiting approval, plus finished runs whose report is not seen yet.
import { app } from "electron";
import {
  type AttentionProposal,
  attentionChannels,
} from "../../../shared/desktop";
import type { NotificationTarget } from "../../../shared/notifications";
import {
  type OrchestrationEvent,
  type OrchestrationRun,
  orchestrationChannels,
  type RunReport,
} from "../../../shared/orchestration";
import { handle, onBroadcast } from "../ipc";
import { arity, id, slug } from "../ipc-args";
import { setAttentionItems } from "../menu-bar";
import { orchestrationMain } from "../orchestration";
import { menuBarProjects } from "../projects";
import { notify, openTarget } from "./index";

/** A report older than this when first seen is old news, not a finish. */
const FRESH_MS = 2 * 60_000;

/** What one run contributes, kept in place of the whole run. */
interface RunAttention {
  project: string;
  lead: string;
  /** Tasks waiting on the person, with the request that makes each one new. */
  waiting: { task: string; title: string; request: string }[];
  report: RunReport | null;
}

const runs = new Map<string, RunAttention>();
let proposals: AttentionProposal[] = [];
/** Reports the person opened, by run id. Kept for the life of the app. */
const seenReports = new Set<string>();
/** Items the person opened from the menu bar, by item key. */
const dismissed = new Set<string>();
/** Runs that already got their notification. */
const notified = new Set<string>();

export interface AttentionItem {
  key: string;
  label: string;
  target: NotificationTarget;
}

/** "3 done, 1 failed, 1 needs you", leaving out what is zero. */
export function reportSummary(report: RunReport): string {
  const parts: string[] = [];
  if (report.done.length) parts.push(`${report.done.length} done`);
  if (report.failed.length) parts.push(`${report.failed.length} failed`);
  if (report.needsYou.length)
    parts.push(
      `${report.needsYou.length} ${report.needsYou.length === 1 ? "needs" : "need"} you`,
    );
  return parts.join(", ") || "Nothing to report";
}

function shorten(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Every item that needs the person right now, oldest source first. */
export function attentionItems(): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const [runId, run] of runs) {
    const target: NotificationTarget = {
      kind: "run",
      slug: run.project,
      conversation: run.lead,
      run: runId,
    };
    for (const task of run.waiting) {
      const key = `worker:${runId}:${task.task}:${task.request}`;
      if (dismissed.has(key)) continue;
      items.push({
        key,
        label: shorten(`${task.title} needs your input`),
        target,
      });
    }
    if (run.report && !run.report.seen && !seenReports.has(runId)) {
      items.push({
        key: `report:${runId}`,
        label: shorten(`Run finished with ${reportSummary(run.report)}`),
        target,
      });
    }
  }
  for (const proposal of proposals) {
    const key = `proposal:${proposal.id}`;
    if (dismissed.has(key)) continue;
    items.push({
      key,
      label: shorten(`Approve ${proposal.title || "a plan"}`),
      target: {
        kind: "session",
        slug: proposal.project,
        conversation: proposal.conversation,
      },
    });
  }
  return items;
}

let lastSignature = "";

/** Push the current items to the dock and the menu bar when they changed. */
function refresh(): void {
  const items = attentionItems();
  const signature = items.map((item) => item.key + item.label).join("\n");
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (process.platform === "darwin")
    app.dock?.setBadge(items.length ? String(items.length) : "");
  setAttentionItems(
    items.map((item) => ({
      label: item.label,
      open: () => {
        dismissed.add(item.key);
        if (item.key.startsWith("report:"))
          seenReports.add(item.key.slice("report:".length));
        openTarget(item.target);
        refresh();
      },
    })),
  );
}

function summarize(run: OrchestrationRun): RunAttention {
  const live = run.status === "active" || run.status === "paused";
  return {
    project: run.project,
    lead: run.lead,
    waiting: live
      ? run.tasks.flatMap((task) =>
          task.needsInput
            ? [
                {
                  task: task.id,
                  title: task.title,
                  request: task.needsInput.requestId,
                },
              ]
            : [],
        )
      : [],
    report: run.report ?? null,
  };
}

/**
 * Take in a run as the engine broadcast it. Idempotent: the run's entry is
 * replaced, and a run is notified once, so the same event twice changes
 * nothing. {@link registerAttention} hears every `orchestration:changed`
 * broadcast and passes it here.
 */
export function observeRun(event: OrchestrationEvent): void {
  const run = event.run;
  const next = summarize(run);
  if (!next.waiting.length && !next.report) runs.delete(run.id);
  else runs.set(run.id, next);

  const report = next.report;
  if (
    report &&
    !notified.has(run.id) &&
    Date.now() - report.finishedAt < FRESH_MS
  ) {
    notified.add(run.id);
    void notify({
      kind: "runs",
      title: run.status === "finished" ? "Run finished" : "Run stopped",
      body: reportSummary(report),
      target: {
        kind: "run",
        slug: run.project,
        conversation: run.lead,
        run: run.id,
      },
    });
  } else if (report) notified.add(run.id);
  refresh();
}

/**
 * Read the runs the engine already has, so a report left unseen when the app
 * quit still counts (FE-136/D6). Nothing is notified for them: a report that
 * old is not news.
 */
async function loadStoredRuns(): Promise<void> {
  for (const project of await menuBarProjects())
    for (const run of await orchestrationMain.runs(project.slug))
      observeRun({ project: run.project, run });
}

/** Register the channels that mark a report seen and list the proposals. */
export function registerAttention(devUrl: string | undefined): void {
  onBroadcast((channel, payload) => {
    if (channel === orchestrationChannels.changed)
      observeRun(payload as OrchestrationEvent);
  });
  handle(
    attentionChannels.markReportSeen,
    devUrl,
    async (args): Promise<void> => {
      const [project, runId] = arity(args, 2);
      slug(project);
      const run = id(runId, "A run is required");
      seenReports.add(run);
      refresh();
      // Saved on the run, so it stays seen after a restart.
      await orchestrationMain.markReportSeen(run);
    },
  );
  handle(attentionChannels.setProposals, devUrl, (args): void => {
    const [list] = arity(args, 1);
    if (!Array.isArray(list) || list.length > 50)
      throw new Error("A list of proposals is required.");
    proposals = list.map((entry) => {
      const raw = (entry ?? {}) as Record<string, unknown>;
      return {
        id: id(raw.id),
        project: slug(raw.project),
        conversation: id(raw.conversation),
        title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
      };
    });
    refresh();
  });
  void loadStoredRuns().catch((error: unknown) =>
    console.warn("Unable to read stored runs for attention", error),
  );
}
