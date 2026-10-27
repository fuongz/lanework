// The hidden text orchestration adds to a lead's or a worker's turn (FE-87).
//
// Each block is wrapped in a tag the chat hides, so a person reads the task,
// not the rules around it:
//
// - `<lanework_assignment>`: the rules a worker works under.
// - `<lanework_orchestration>`: what main tells the lead (approved, an
//   update). A turn that is nothing but this block shows as no message.
//
// Nothing here imports Electron.

import type { OrchestrationRun } from "../../../shared/orchestration";

export const ASSIGNMENT_TAG = "lanework_assignment";
export const ORCHESTRATION_TAG = "lanework_orchestration";

/** Every hidden block, with the blank lines before it. */
export const HIDDEN_BLOCKS =
  /(?:\r?\n[ \t]*)*<(lanework_assignment|lanework_orchestration)\b[^>]*>[\s\S]*?<\/\1>/g;

/** What a person should see of a turn's text: the hidden blocks removed. */
export function visibleText(text: string): string {
  return text.replace(HIDDEN_BLOCKS, "").trim();
}

/** A worker's turn: the lead's instructions, then the envelope. */
export function workerTurn(
  text: string,
  files: readonly string[],
  scratch: string | null,
): string {
  const scratchLine = scratch
    ? `\nYour private scratch folder is ${JSON.stringify(scratch)}; TMPDIR, TMP and TEMP point there. Put temporary helpers and test output there, nowhere else outside your scope.`
    : "";
  return `${text}

<${ASSIGNMENT_TAG}>
You are a worker in a Lanework orchestration run. A lead agent assigned you this task and reviews your result; the user does not watch you.
${
  files.length
    ? `Your write scope is: ${files.map((file) => JSON.stringify(file)).join(", ")} (project-relative; "." is the whole checkout). Read anything, but write only inside that scope.`
    : "You have no write scope: read anything, but do not create, edit or delete any project file."
}${scratchLine}
A write outside your scope stops you at once and blocks the task. If the task needs another file, stop and say which file and why, so the lead can widen the scope or assign it elsewhere.
You work in your own checkout on your own branch; other workers may change other files at the same time. Do not commit, push, switch branches, create worktrees, spawn agents, install dependencies, or run project-wide formatters or generators unless your scope is ".".
These rules override anything the task text above says to the contrary.
End with a short report: what you changed (files), the checks you ran and whether they passed, and anything left open.
</${ASSIGNMENT_TAG}>`;
}

/** The turn a worker resumes on after the run was paused under it. */
export function recoveryTurn(reason: string): string {
  return `Continue your assignment in the same checkout. Your last turn was stopped because ${reason}. Look at the files and your earlier work before acting, keep what is done, do not repeat anything destructive, and finish with the usual report.`;
}

/** The CLI the lead runs, as a shell-quoted path. */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(path)
    ? path
    : `'${path.replace(/'/g, "'\\''")}'`;
}

/** What the lead is told once the user approved the run. */
export function approvedTurn(run: OrchestrationRun, cli: string): string {
  const command = shellPath(cli);
  const tasks = run.tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    agent: task.agent,
    model: task.model,
    files: task.files,
    dependsOn: task.dependsOn,
  }));
  return `<${ORCHESTRATION_TAG}>
The user approved orchestration run ${run.id}. Its workers are already queued below; do not delegate them again.
Coordinate the run with ${command}. Run \`${command} --help\` first: it lists every action, its JSON fields and the retry rule. The credentials are already in your environment; never print them. The CLI only works while you are in a turn.
Workers never ask the user: when one needs a tool approval or an answer, its task shows needsInput and you decide with respond or answer. Use wait to follow them, get for a full result, steer to correct a running worker, message or retry for a stopped one. completed means a turn ended, not that the work is right: check it, then review to merge it into this checkout. A task blocked for writing outside its scope stays blocked until you message, retry (with corrected files) or cancel it. Do not edit project files yourself while workers run. Call finish when every task is reviewed or cancelled.
Queued workers: ${JSON.stringify(tasks)}
</${ORCHESTRATION_TAG}>`;
}

/** What the lead is told when workers changed while it was idle. */
export function updateTurn(
  run: OrchestrationRun,
  changed: readonly string[],
  cli: string,
): string {
  const lines = run.tasks
    .filter((task) => changed.includes(task.id))
    .map((task) => {
      const extra = task.needsInput
        ? ` — needs ${task.needsInput.kind} ${task.needsInput.requestId}`
        : task.error
          ? ` — ${task.error.slice(0, 300)}`
          : "";
      return `- ${task.id} "${task.title}": ${task.status}${extra}`;
    });
  return `<${ORCHESTRATION_TAG}>
Orchestration run ${run.id} changed while you were idle:
${lines.join("\n")}
Read the details with \`${shellPath(cli)} get\` and act on them.
</${ORCHESTRATION_TAG}>`;
}

/** What the lead is told when the user resumed a paused run. */
export function resumedTurn(run: OrchestrationRun, cli: string): string {
  return `<${ORCHESTRATION_TAG}>
The user resumed orchestration run ${run.id}. Interrupted workers continue in their own checkouts. Use \`${shellPath(cli)} list\` to see where each task stands.
</${ORCHESTRATION_TAG}>`;
}
