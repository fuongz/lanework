// The composer's unsent text, kept in localStorage by conversation — or
// `new:<slug>` for the new-conversation page — so it outlives a switch to
// another one, or a restart.
import { readStored, writeStored } from "./stored";

const PREFIX = "lanework.draft.";

/**
 * Drafts of deleted conversations: never written again, though the open
 * composer still flushes its text on the way out.
 */
const forgotten = new Set<string>();

export function readDraft(key: string): string {
  return readStored(PREFIX + key) ?? "";
}

export function writeDraft(key: string, text: string) {
  if (forgotten.has(key)) return;
  writeStored(PREFIX + key, text.trim() ? text : null);
}

/** Drops a deleted conversation's draft, and keeps it from coming back. */
export function forgetDraft(key: string) {
  forgotten.add(key);
  writeStored(PREFIX + key, null);
}
