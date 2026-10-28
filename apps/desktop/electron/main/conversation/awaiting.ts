// The conversations an engine is waiting on the person in (FE-97), across
// every workspace: what the rail's ping and the island read first, and what
// decides when a desktop notification goes out.
//
// NOTE: Pure. It only follows the engines' events; it never asks an engine.
import type {
  Awaiting,
  ConversationAgent,
  ConversationEvent,
  PermissionRequest,
} from "../../../shared/conversation";

/** How many conversations are kept; the oldest goes first. */
const LIMIT = 64;

/** How long a notification's body may be, in characters. */
const BODY_MAX = 140;

interface Open {
  workspace: string;
  conversation: string;
  agent: ConversationAgent;
  /** By id, in the order they were asked. */
  requests: Map<string, Awaiting["requests"][number] & { at: number }>;
}

/**
 * A ledger of the requests engines are waiting on, by workspace and
 * conversation.
 *
 * @param now The clock, for `since`.
 */
export function createAwaitingLedger(now: () => number = Date.now) {
  const open = new Map<string, Open>();
  const keyOf = (workspace: string, conversation: string) =>
    `${workspace}\0${conversation}`;

  function clear(workspace: string, conversation: string): void {
    open.delete(keyOf(workspace, conversation));
  }

  return {
    /**
     * Follow one engine event.
     *
     * - `permission` adds its request;
     * - `permission-done` removes it;
     * - `state` clears the conversation unless its engine is starting or
     *   running: an engine that stopped waits on no one.
     *
     * @param agent The CLI running the conversation, asked only for a
     *   conversation not in the ledger yet.
     * @returns The request when it is new, for the caller to tell the person
     *   about; null for anything else, a request seen before included.
     */
    apply(
      event: ConversationEvent,
      agent: () => ConversationAgent,
    ): PermissionRequest | null {
      // A new Codex conversation has no id until Codex names it.
      if (typeof event.conversation !== "string") return null;
      const key = keyOf(event.workspace, event.conversation);
      if (event.type === "state") {
        if (
          event.engine.state !== "running" &&
          event.engine.state !== "starting"
        )
          open.delete(key);
        return null;
      }
      if (event.type === "permission-done") {
        const entry = open.get(key);
        entry?.requests.delete(event.id);
        if (entry && entry.requests.size === 0) open.delete(key);
        return null;
      }
      if (event.type !== "permission") return null;
      const { request } = event;
      let entry = open.get(key);
      if (entry?.requests.has(request.id)) return null;
      if (!entry) {
        entry = {
          workspace: event.workspace,
          conversation: event.conversation,
          agent: agent(),
          requests: new Map(),
        };
        open.set(key, entry);
        if (open.size > LIMIT) open.delete(open.keys().next().value as string);
      }
      entry.requests.set(request.id, {
        id: request.id,
        tool: request.tool,
        summary: request.summary,
        question: request.questions?.[0]?.question ?? null,
        at: now(),
      });
      return request;
    },

    /** Forget a conversation: its engine closed. */
    clear,

    /** Every conversation waiting, oldest request first in each. */
    list(): Awaiting[] {
      return [...open.values()].map((entry) => {
        const requests = [...entry.requests.values()];
        return {
          workspace: entry.workspace,
          conversation: entry.conversation,
          agent: entry.agent,
          requests: requests.map(({ at: _, ...request }) => request),
          since: new Date(
            Math.min(...requests.map((request) => request.at)),
          ).toISOString(),
        };
      });
    },
  };
}

export type AwaitingLedger = ReturnType<typeof createAwaitingLedger>;

/**
 * The desktop notification for a new request: who asks, and what.
 *
 * A question card says the agent is asking; any other tool, that it needs
 * permission. The body is the first question, else the request's summary, on
 * one line and cut at {@link BODY_MAX} characters.
 */
export function awaitingNotice(
  agent: ConversationAgent,
  request: PermissionRequest,
): { title: string; body: string } {
  const who = agent === "codex" ? "Codex" : "Claude";
  const question = request.questions?.[0]?.question;
  const text = (question || request.summary || request.tool)
    .replace(/\s+/g, " ")
    .trim();
  return {
    title: request.questions ? `${who} is asking` : `${who} needs permission`,
    body:
      text.length > BODY_MAX
        ? `${text.slice(0, BODY_MAX - 1).trimEnd()}…`
        : text,
  };
}
