// What the composer knew of the attachments it sent, for the chat to draw
// them in place: an image's thumbnail and a file's size. The transcript keeps
// an image's bytes but not its name or a file's size, so this is the only
// place they are, and only for messages sent since the app started.

export interface SentAttachment {
  name: string;
  /** Bytes, when the composer read them. */
  size?: number;
  /** An image's object or data URL. */
  preview?: string;
}

/** The newest last; the oldest go past {@link KEEP}. */
const sent = new Map<string, SentAttachment>();
const KEEP = 200;

/**
 * An image is told by its name and size (a pasted screenshot is always
 * `image.png`); a file by its name alone.
 */
const keyOf = (name: string, size?: number) =>
  size === undefined ? name : `${name}\u0000${size}`;

export function rememberSent(files: readonly SentAttachment[]) {
  for (const file of files) {
    for (const key of [keyOf(file.name, file.size), keyOf(file.name)]) {
      sent.delete(key);
      sent.set(key, file);
    }
  }
  while (sent.size > KEEP) {
    const oldest = sent.keys().next().value;
    if (oldest === undefined) break;
    sent.delete(oldest);
  }
}

/** What was sent as `name` (of `size` bytes, when known), if anything. */
export function sentAttachment(
  name: string,
  size?: number,
): SentAttachment | undefined {
  return sent.get(keyOf(name, size));
}
