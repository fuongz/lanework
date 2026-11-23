// Where every engine asks the project's rules before it shows a permission
// card (FE-165), and where orchestration asks them for a worker.
//
// Nothing here runs until a request comes: `installPermissions` only keeps
// the store, and the store reads a project's file on its first request.
// An engine imports this file, never `permissions/index.ts`.

import { homedir } from "node:os";
import type {
  ConversationAgent,
  PermissionRequest,
} from "../../../shared/conversation";
import type { PermissionRule } from "../../../shared/permissions";
import { redact } from "../../hook/redact";
import {
  type EngineTarget,
  leadGuarded,
  runWorker,
} from "../orchestration/engine-tap";
import {
  evaluate,
  type PermissionSubject,
  subjectSummary,
  subjectTool,
  type Verdict,
} from "./matcher";
import type { PermissionStore } from "./store";

/** The conversation a request comes from, and where it runs. */
export interface GateTarget {
  project: string;
  conversation: string;
  agent: ConversationAgent;
  /** Its checkout: a worker's is its own worktree. */
  folder: string;
  /** Other folders a write may land in (a worker's scratch). */
  roots?: readonly string[];
}

type ConductorOf = (
  project: string,
  agent: ConversationAgent,
  conversation: string,
) => Promise<string | null>;

let store: PermissionStore | null = null;
let conductorOf: ConductorOf | null = null;

/** Hand in the store; main does once, before any engine runs. */
export function installPermissions(next: PermissionStore | null): void {
  store = next;
}

/** How a conversation's conductor is told, for a rule's `conductor`. */
export function setPermissionConductors(next: ConductorOf | null): void {
  conductorOf = next;
}

/**
 * The subject each card was built from, for "Always allow". Held by the
 * card's own object, so it goes when the card does.
 */
const subjects = new WeakMap<PermissionRequest, PermissionSubject>();

export function noteSubject(
  request: PermissionRequest,
  subject: PermissionSubject | null,
): void {
  if (subject) subjects.set(request, subject);
}

export function subjectOf(
  request: PermissionRequest,
): PermissionSubject | null {
  return subjects.get(request) ?? null;
}

/**
 * Whether an engine may answer a request from the rules itself: not for a
 * lead whose edit tools are off (FE-136), nor for a run worker, whose
 * requests orchestration answers after its scope guard.
 */
export function engineMayAnswer(target: EngineTarget): boolean {
  return !leadGuarded(target) && !runWorker(target);
}

/**
 * What the rules say of `subject`; null when there is no store, or the
 * rules could not be read (then the card shows, as before).
 */
export async function verdictFor(
  target: GateTarget,
  subject: PermissionSubject,
): Promise<{ verdict: Verdict; conductor: string | null } | null> {
  if (!store) return null;
  try {
    const rules = await store.ownRules(target.project);
    const conductor = rules.some((rule) => rule.conductor)
      ? await (conductorOf?.(
          target.project,
          target.agent,
          target.conversation,
        ) ?? null)
      : null;
    return {
      verdict: evaluate(rules, subject, {
        checkout: target.folder,
        roots: target.roots,
        home: homedir(),
        conductor,
      }),
      conductor,
    };
  } catch (error) {
    console.error("Could not read the permission rules", error);
    return null;
  }
}

/** Keep one automatic allow in the project's audit list. */
export function recordAutoAllow(
  target: GateTarget,
  subject: PermissionSubject,
  rule: PermissionRule,
  conductor: string | null,
): void {
  store?.record(target.project, {
    at: new Date().toISOString(),
    tool: subjectTool(subject),
    summary: redact(subjectSummary(subject)) || subjectTool(subject),
    ruleId: rule.id,
    conversation: target.conversation,
    ...(conductor ? { conductor } : {}),
  });
}

/**
 * Answer a request from the rules when an Allow rule matches and no Ask
 * rule does.
 *
 * @param answer Answers the request; returns false when it is no longer
 *   waiting (the turn ended meanwhile). Only a true answer is audited.
 * @returns Whether it was answered: false means show the card.
 */
export async function autoAllow(
  target: GateTarget,
  subject: PermissionSubject | null,
  answer: () => boolean,
): Promise<boolean> {
  if (!subject) return false;
  const found = await verdictFor(target, subject);
  if (found?.verdict.effect !== "allow") return false;
  if (!answer()) return false;
  recordAutoAllow(target, subject, found.verdict.rule, found.conductor);
  return true;
}
