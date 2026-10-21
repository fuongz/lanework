/**
 * The composer's unsent text, kept in localStorage by conversation — or
 * `new:<slug>` for the new-conversation page — so it outlives a switch to
 * another one, or a restart.
 */
const PREFIX = "lanework.draft.";

/**
 * Drafts of deleted conversations: never written again, though the open
 * composer still flushes its text on the way out.
 */
const forgotten = new Set<string>();

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string) {
  if (forgotten.has(key)) return;
  try {
    if (text.trim()) localStorage.setItem(PREFIX + key, text);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // A full or unavailable storage only costs the draft.
  }
}

/** The conversation is deleted: its draft goes with it. */
export function forgetDraft(key: string) {
  forgotten.add(key);
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to forget.
  }
}
