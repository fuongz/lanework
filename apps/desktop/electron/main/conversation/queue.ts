// What a conversation's engine holds back (FE-67).
//
// A message sent while a turn runs goes into that turn at once: it steers it.
// One the CLI cannot take in yet waits here, in order, and goes as soon as it
// can. It waits when:
// - the queue is paused;
// - the turn is not ready;
// - it asks for other settings than the running turn's.
//
// Nothing here imports Electron.
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

/** The extensions of an attached path the queue shows as an image. */
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** A held message as the page shows it in the queue. */
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
 * Whether a message may go into a turn that runs on settings `a`.
 *
 * Mid-turn, a message goes in only on the settings the turn runs with. A
 * model, effort, speed or permission of its own waits for a turn of its own.
 *
 * @param a The running turn's settings; null when no turn runs.
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

  /**
   * Take a message out of the queue by id, to edit or to drop.
   *
   * @returns null when no held message has that id.
   */
  remove(id: string): Outgoing | null {
    const at = this.items.findIndex((item) => item.id === id);
    if (at < 0) return null;
    const [item] = this.items.splice(at, 1);
    if (!this.items.length) this.paused = false;
    return item ?? null;
  }

  /**
   * Drop every held message.
   *
   * @returns How many were dropped.
   */
  clear(): number {
    const dropped = this.items.length;
    this.items = [];
    this.paused = false;
    return dropped;
  }

  /**
   * Put messages back in front, in order, and pause the queue.
   *
   * They go in front because they were sent before what waits.
   *
   * @param error Why they did not go, shown on each.
   */
  restore(items: Outgoing[], error: string | null = null): void {
    if (!items.length) return;
    for (const item of items) item.error = error;
    this.items.unshift(...items);
    this.paused = true;
  }

  /** The queue as the page shows it; empty when nothing is held. */
  state(): EngineQueue {
    return this.items.length
      ? { queue: this.items.map(shown), paused: this.paused }
      : {};
  }
}
