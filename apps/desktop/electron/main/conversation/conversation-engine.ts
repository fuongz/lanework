// What every composer engine is to `createEngines` (FE-104/D2): one
// conversation, run by one CLI, whatever that CLI speaks. Claude's headless
// `claude` (`engine.ts`), Codex's `app-server` (`codex-engine.ts`) and
// OpenCode's background service (`opencode-engine.ts`) each implement it, so
// the routing in `createEngines` asks an engine what it is instead of which
// class made it.
//
// Nothing here imports Electron.
import type {
  ConversationAgent,
  EngineState,
  PermissionAnswer,
  PermissionRequest,
  Turn,
} from "../../../shared/conversation";
import type { Held, Outgoing } from "./queue";

export interface ConversationEngine {
  /** The CLI this engine runs. */
  readonly agent: ConversationAgent;
  readonly workspace: string;
  /** The folder it runs in. */
  readonly folder: string;
  /**
   * The conversation's id. Null for a new Codex or OpenCode conversation
   * until the CLI names it.
   */
  readonly conversation: string | null;
  /** A turn runs (or is starting). */
  busy: boolean;
  /** Being stopped: an exit or an end now is not an error. */
  stopping: boolean;
  /** What went wrong last, shown until the next turn starts. */
  error: string | null;
  /**
   * The folder's trust changed while a turn ran: the engine restarts before
   * the next one (FE-101). Never set for an engine without trust.
   */
  stale: boolean;
  /** What waits to be sent. */
  readonly held: Held;
  /** The permission and question cards shown now, by request id. */
  readonly permissions: ReadonlyMap<string, PermissionRequest>;
  /**
   * The running process loads user settings only: Claude has no trust on
   * record for the folder (FE-77/D3). Always false for the others.
   */
  readonly untrusted: boolean;
  /**
   * Resolves with the id once the CLI names a new conversation; at once for
   * one that has its id.
   */
  readonly named: Promise<string>;

  /**
   * The engine's own process id, so a terminal check never counts it; null
   * when it has none (OpenCode's service is the user's, not the engine's).
   */
  pid(): number | null;
  /**
   * Whether the engine holds its CLI open: a process, or OpenCode's event
   * stream. The rail's Running reads this.
   */
  alive(): boolean;
  state(): EngineState;
  /** What the engine holds of the conversation before its CLI wrote it. */
  turns(): Turn[];
  /** Tell the page the state, unless it is the one told last. */
  emitState(): void;
  /** Send `out` (into the running turn, or as a turn), or hold it. */
  accept(out: Outgoing): Promise<void>;
  /** Start `out` as the next turn. */
  deliver(out: Outgoing): Promise<void>;
  /** Let a paused queue go on. */
  resume(): void;
  /**
   * Answer card `id`.
   *
   * @throws When the request was already answered.
   */
  answer(id: string, answer: PermissionAnswer): void;
  /** Interrupt the running turn (the Stop button). */
  stop(): Promise<void>;
  /** End the engine's hold on the CLI and wait for it. */
  halt(): Promise<void>;
  /** Signal the engine to end, without waiting: app quit. */
  kill(): void;
}
