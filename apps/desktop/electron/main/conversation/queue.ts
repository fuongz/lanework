// What a conversation's engine holds back (FE-67). A message sent while a
// turn runs goes into that turn at once (it steers it); one the CLI cannot
// take in yet waits here, in order — the queue is paused, the turn is not
// ready, or it asks for other settings than the running turn's — and goes
// as soon as it can. Nothing here imports Electron.
import { basename, extname } from "node:path";
import type {
  ComposerSettings,
  EngineQueue,
  OutgoingAttachment,
  QueuedMessage,
} from "../../../shared/conversation";
import type { ContentBlock } from "./outgoing";

/** One message on its way to a CLI, as the composer sent it. */
export interface Outgoing {
  /** The page's id for it, or main's own. */
  id: string;
  /** What the composer sent: shown while it waits, given back to edit. */
  text: string;
  attachments: OutgoingAttachment[];
  content: ContentBlock[];
  settings: ComposerSettings;
  /** Why it did not go, while it waits. */
  error?: string | null;
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function shown(out: Outgoing): QueuedMessage {
  return {
    id: out.id,
    text: out.text,
    attachments: out.attachments.map((file) =>
      file.kind === "path"
        ? {
            name: basename(file.path),
            image: IMAGE.has(extname(file.path).toLowerCase()),
          }
        : { name: file.name, image: true },
    ),
    error: out.error ?? null,
  };
}

/**
 * Mid-turn, a message goes in only on the settings the turn runs with: a
 * model, effort, speed or permission of its own waits for a turn of its own.
 */
export function sameSettings(
  a: ComposerSettings | null,
  b: ComposerSettings,
): boolean {
  return (
    !!a &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.fast === b.fast &&
    a.permission === b.permission
  );
}

/** The messages held back, oldest first, and whether Stop paused them. */
export class Held {
  items: Outgoing[] = [];
  paused = false;

  get length(): number {
    return this.items.length;
  }

  /** Out of the queue, by id — taken back to edit, or dropped. */
  remove(id: string): Outgoing | null {
    const at = this.items.findIndex((item) => item.id === id);
    if (at < 0) return null;
    const [item] = this.items.splice(at, 1);
    if (!this.items.length) this.paused = false;
    return item ?? null;
  }

  clear(): number {
    const dropped = this.items.length;
    this.items = [];
    this.paused = false;
    return dropped;
  }

  /** Back in front, in order — they were sent before what waits. */
  restore(items: Outgoing[], error: string | null = null): void {
    if (!items.length) return;
    for (const item of items) item.error = error;
    this.items.unshift(...items);
    this.paused = true;
  }

  state(): EngineQueue {
    return this.items.length
      ? { queue: this.items.map(shown), paused: this.paused }
      : {};
  }
}
