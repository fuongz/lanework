import type {
  AgentCard,
  AgentSubagent,
  BackgroundCount,
  TerminalAgent,
} from "../../shared/terminal";

/**
 * Where a row came from.
 *
 * `lanework`: a conversation Lanework started itself. `pulled`: one read in
 * from a CLI's own files by a Pull, or a stub a legacy mark made that a Pull
 * fills in later.
 */
export type SessionOrigin = "lanework" | "pulled";

/**
 * What a CLI says about one conversation: everything `upsertSession` writes.
 *
 * An optional field left out keeps what the row has; `null` clears it.
 */
export interface SessionUpsert {
  agent: TerminalAgent;
  /** The CLI's own id, of the shape `isAgentSessionIdOf` accepts. */
  id: string;
  /** The project whose rail lists it: the cloud id, or the slug. */
  project: string;
  /** The folder the CLI ran it in. */
  folder?: string | null;
  /** Its title as the CLI named it, or its first prompt. */
  cliTitle: string;
  /** When it was last written to, ISO. */
  updatedAt: string;
  /** When it began, ISO. Only a new row takes it; default now. */
  createdAt?: string;
  /** Only a new row takes it; default `pulled`. */
  origin?: SessionOrigin;
  working?: boolean;
  card?: AgentCard | null;
  background?: BackgroundCount;
  /** The CLI's transcript, or null when it keeps none as a file. */
  sourcePath?: string | null;
}

/** The CLI's fields an ingest may update with its position. */
export type SessionFields = Partial<
  Omit<SessionUpsert, "agent" | "id" | "project" | "createdAt" | "origin">
>;

/**
 * Lanework's own marks on a conversation.
 *
 * NOTE: No CLI write ever changes one: `upsertSession` and `saveIngest`
 * leave all four as they are.
 */
export interface SessionMarks {
  /** The name given in Lanework; null means the CLI's own title. */
  name: string | null;
  /** Epoch ms it was pinned, or null. */
  pinnedAt: number | null;
  /** The conductor whose own conversation it is, and in which project. */
  conductor: { id: string; project: string } | null;
  /** When it was archived in Lanework, ISO, or null. */
  archivedAt: string | null;
}

/** One row of `agent_session`, decoded. */
export interface StoredSession extends SessionMarks {
  /** `agent:id`. */
  key: string;
  agent: TerminalAgent;
  id: string;
  /** Null for a stub no Pull has filled in yet. */
  project: string | null;
  folder: string | null;
  cliTitle: string;
  origin: SessionOrigin;
  createdAt: string;
  updatedAt: string;
  working: boolean;
  card: AgentCard | null;
  background: BackgroundCount;
  sourcePath: string | null;
  /** Newest first. */
  subagents: AgentSubagent[];
}

/**
 * How far a conversation's transcript has been read, and what the reader
 * kept to carry on from there.
 */
export interface IngestState<T = unknown> {
  path: string | null;
  /** The file's size when it was last read, in bytes. */
  size: number | null;
  /** The file's mtime when it was last read, epoch ms. */
  mtime: number | null;
  /** The byte the next read starts at. */
  offset: number | null;
  /** The reader's own state, as it saved it; null before the first read. */
  state: T | null;
}

/** What one ingest step saves, in one write. */
export interface IngestSave {
  size: number;
  mtime: number;
  offset: number;
  /** Stored as JSON. */
  state: unknown;
  /** What the read found out about the conversation. */
  fields?: SessionFields;
}

/**
 * One legacy mark, as `agent-sessions.json` held it (FE-24, FE-25, FE-95).
 *
 * NOTE: The shape `main/terminal/agent-marks.ts` parses, restated here
 * because that module does not export it. Structural, so what it parses
 * passes straight in.
 */
export interface LegacyMark {
  name?: string;
  pinnedAt?: number;
  conductor?: { id: string; project: string };
}

/** Every legacy mark, by `agent:id`. */
export type LegacyMarks = Record<string, LegacyMark>;

type SessionStoreErrorCode = "invalid" | "closed";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;
  constructor(code: SessionStoreErrorCode, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}
