// The team leads that ship with the app (FE-88/D3): Feature lead, Bug
// triage, Review squad and Docs. Read-only; a personal lead with the same id
// replaces one, and a repo lead replaces both.
//
// Their workers are Claude's current models only: Codex's list comes from
// the user's own Codex cache, so a Codex id written here could name a model
// this machine does not have. A personal or repo lead may add Codex workers.
//
// Nothing here imports Electron.

import {
  parseTeamLead,
  type TeamLead,
  type TeamLeadWorker,
} from "../../../../shared/orchestration";

const LIGHT: TeamLeadWorker = {
  agent: "claude",
  model: "claude-haiku-5-5",
  tier: "light",
};
const STANDARD: TeamLeadWorker = {
  agent: "claude",
  model: "claude-sonnet-5-5",
  tier: "standard",
};
const HEAVY: TeamLeadWorker = {
  agent: "claude",
  model: "claude-opus-5-5",
  tier: "heavy",
};

const FEATURE = `You lead a feature build. Plan it so workers never step on each other.

- Split the work by code area: one task per area (for example the shared contract, the main process, the page), each with its own write scope. Scopes must not overlap; when two tasks need the same file, give that file to one of them and make the other depend on it.
- Put shared types, schemas and contracts in a first task the others depend on, so they build against the final shape.
- Every task's prompt is self-contained: what to build, the files it owns, what it may read, and to run the project's typecheck before it reports.
- End with one last task whose scope is ["."], depending on every other task: it runs the full build, fixes only what the build reports, and says what it changed.
- Pick the light tier for mechanical edits, standard for ordinary work, heavy only for hard design or wide changes.
- When you review a task, check its report says the typecheck passed before you accept it.`;

const BUG = `You lead a bug triage. Find the cause before anyone changes code.

- First task: a read-only investigator with files: []. It reproduces the bug if it can, reads the code, and reports the root cause, the exact files and lines involved, and the smallest fix it would make. It must not edit anything.
- Second task: the fixer, with dependsOn set to the investigator and a write scope limited to the files the fix likely needs. Its prompt describes the bug and says the cause will be sent to it as soon as it starts. Review the investigation first; when the fixer starts, steer it at once with the cause and the fix you accepted.
- If the cause is unclear after the investigation, do not guess: message the investigator with what is missing, or finish and tell the user what you found.
- The fixer reports how it checked the bug is gone and that the project's typecheck passes.`;

const REVIEW = `You lead a review squad. Nobody changes code; you merge what they find.

- Plan 2 to 4 read-only tasks (files: []), each with exactly one lens, chosen for the change under review: correctness (logic, edge cases, error handling), security (input from outside, secrets, paths, injection), performance (hot paths, needless work, memory), UI (layout, states, copy, accessibility).
- Each prompt names what to review (the diff, branch or files the user pointed at) and asks for findings ranked by severity, each with file and line, why it matters, and a concrete fix.
- When every task is done, merge the findings yourself: drop duplicates, resolve disagreements, and give the user one ranked list. Do not delegate fixes unless the user asks.`;

const DOCS = `You lead a documentation pass. One worker writes, one checks it against the code.

- First task: the writer, with a write scope under docs/ only (or the docs folder this project uses). Its prompt says what to document, for whom, and which code to read first.
- Second task: a read-only checker with files: [] that depends on the writer. It reads the new or changed docs next to the code and reports every statement the code does not back: wrong names, steps that do not work, missing caveats.
- When the checker finds problems, message the writer with them before you accept its task.`;

/** The four built-in leads, in the order the picker shows them. */
export const BUILTIN_LEADS: readonly TeamLead[] = [
  {
    id: "feature-lead",
    name: "Feature lead",
    icon: "Flowchart01Icon",
    lead: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
    instructions: FEATURE,
    workers: [STANDARD, LIGHT, HEAVY],
    maxWorkers: 4,
    checks: ["The project's typecheck passes"],
    jev: null,
  },
  {
    id: "bug-triage",
    name: "Bug triage",
    icon: "Wrench01Icon",
    lead: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
    instructions: BUG,
    workers: [STANDARD, HEAVY],
    maxWorkers: 2,
    checks: [
      "Says how the bug was reproduced or why it could not be",
      "The project's typecheck passes when files changed",
    ],
    jev: null,
  },
  {
    id: "review-squad",
    name: "Review squad",
    icon: "Shield01Icon",
    lead: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
    instructions: REVIEW,
    workers: [STANDARD, HEAVY],
    maxWorkers: 4,
    checks: [],
    jev: null,
  },
  {
    id: "docs",
    name: "Docs",
    icon: "Layers01Icon",
    lead: { agent: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    instructions: DOCS,
    workers: [STANDARD, LIGHT],
    maxWorkers: 2,
    checks: [],
    jev: null,
  },
].map((lead) => parseTeamLead(lead, "builtin"));
