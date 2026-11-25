// The messaging gateway (PD-06): one conversation the app started messages
// another, through whichever channel reaches it.
//
// Channels are adapters, tried in order: the first whose `canReach` holds
// delivers, and one that fails hands the message to the next. Today:
//
// - `claude-peer`: both ends run on Claude Code, whose sessions message each
//   other natively (`SendMessage` to the receiver's socket). Main never
//   writes into that socket itself (an undocumented protocol whose sender
//   declares its own identity and permission mode, PD-06 spike): the sending
//   agent is told the address and sends it, and the adapter checks it
//   arrived, falling back when it did not.
// - `lanework`: the app's own delivery, a tagged turn queued on the
//   receiver's engine like a conductor's reports. Every CLI takes it.
//
// A CLI that gains a native channel gets an adapter of its own, registered
// ahead of `lanework`; nothing else changes. Whatever carried it, the
// message reads the same in the receiver's chat (FE-169's peer card).
// Nothing here imports Electron.
import type { ConversationAgent } from "../../../../shared/conversation";

/** One end of a message: a conversation the app runs. */
export interface Endpoint {
  project: string;
  /** Its newest native session: where its engine runs. */
  conversation: string;
  /** Its thread's head: what the app names it by. */
  head: string;
  agent: ConversationAgent;
  /** What the other end calls it: a conductor's name, a session's title. */
  name: string;
  /** Its engine's process id while it runs; null otherwise. */
  pid: number | null;
}

export interface Outbound {
  from: Endpoint;
  to: Endpoint;
  summary?: string;
  text: string;
}

/** How a message went, as the sender is told. */
export type Delivery =
  | {
      channel: string;
      status: "delivered";
      /** The receiver was busy: it reads the message once its turn ends. */
      queued: boolean;
    }
  | {
      channel: "claude-peer";
      status: "send-it";
      /** Where the sending agent's SendMessage goes. */
      address: string;
    };

export interface ChannelAdapter {
  readonly id: string;
  /** Whether this channel can carry `message` now. */
  canReach(message: Outbound): Promise<boolean>;
  /** @throws When it could not, for the next channel to try. */
  deliver(message: Outbound): Promise<Delivery>;
}

export class MessagingError extends Error {}

/** The gateway: the adapters, tried in the order given. */
export class MessageGateway {
  constructor(private readonly adapters: readonly ChannelAdapter[]) {}

  /**
   * Deliver `message` through the first channel that takes it.
   *
   * @throws {MessagingError} When no channel could.
   */
  async send(message: Outbound): Promise<Delivery> {
    const failures: string[] = [];
    for (const adapter of this.adapters) {
      if (!(await adapter.canReach(message).catch(() => false))) continue;
      try {
        return await adapter.deliver(message);
      } catch (error) {
        failures.push(
          `${adapter.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new MessagingError(
      failures.length
        ? `The message could not be delivered (${failures.join("; ")}).`
        : `No channel reaches ${message.to.name}.`,
    );
  }
}

// ─── Adapters ───────────────────────────────────────────────────────────────

/** The tag a message rides in, the one Claude's peers use (FE-169). */
export function peerEnvelope(message: Outbound, text: string): string {
  const attr = (value: string) => value.replace(/["<>\n]/g, " ").trim();
  return [
    "Another Lanework conversation sent a message:",
    `<cross-session-message from="lanework:${attr(message.from.head)}" from-name="${attr(message.from.name)}" from-mode="lanework">`,
    text,
    "</cross-session-message>",
  ].join("\n");
}

export interface LaneworkAdapterDeps {
  /**
   * Queue `text` as a turn of `to`'s engine, or start one: what a send
   * from the composer does. Answers whether it waits behind a running turn.
   */
  deliver: (to: Endpoint, text: string) => Promise<{ queued: boolean }>;
  /** The message's text with its summary ahead of it (BE-06). */
  body: (message: Outbound) => string;
}

/** The app's own channel: any CLI, idle or busy (queued, PD-06/D3). */
export function laneworkAdapter(deps: LaneworkAdapterDeps): ChannelAdapter {
  return {
    id: "lanework",
    canReach: async () => true,
    deliver: async (message) => {
      const { queued } = await deps.deliver(
        message.to,
        peerEnvelope(message, deps.body(message)),
      );
      return { channel: "lanework", status: "delivered", queued };
    },
  };
}

export interface ClaudePeerAdapterDeps {
  /** Whether Claude's peer socket of process `pid` exists. */
  socketOf: (pid: number) => Promise<string | null>;
  /**
   * Whether `to` got a message from process `fromPid` since `since`
   * (epoch ms): its transcript holds the peer line.
   */
  arrived: (to: Endpoint, fromPid: number, since: number) => Promise<boolean>;
  /** Hand an undelivered message to the next channel (`lanework`). */
  fallback: (message: Outbound) => Promise<unknown>;
  /** How long the sending agent has to send it, in ms. */
  checkAfterMs?: number;
  /** Schedules the check; `setTimeout` outside a test. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Claude to Claude: the sending agent sends it itself with SendMessage, as
 * its own identity and permission mode. The gateway answers with the
 * address, then checks the receiver's transcript and falls back when the
 * message never arrived.
 */
export function claudePeerAdapter(deps: ClaudePeerAdapterDeps): ChannelAdapter {
  const later =
    deps.later ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref?.();
    });
  return {
    id: "claude-peer",
    canReach: async (message) =>
      message.from.agent === "claude" &&
      message.to.agent === "claude" &&
      message.from.pid !== null &&
      message.to.pid !== null &&
      (await deps.socketOf(message.to.pid)) !== null,
    deliver: async (message) => {
      const socket = await deps.socketOf(message.to.pid as number);
      if (!socket) throw new Error("the receiver's socket is gone");
      const since = Date.now();
      const fromPid = message.from.pid as number;
      later(() => {
        void deps
          .arrived(message.to, fromPid, since)
          .catch(() => false)
          .then((arrived) => (arrived ? null : deps.fallback(message)))
          .catch(() => {});
      }, deps.checkAfterMs ?? 120_000);
      return {
        channel: "claude-peer",
        status: "send-it",
        address: `uds:${socket}`,
      };
    },
  };
}
