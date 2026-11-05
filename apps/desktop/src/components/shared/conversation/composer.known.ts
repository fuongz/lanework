import { useSyncExternalStore } from "react";
import type { Suggestion } from "#/../shared/conversation";

/**
 * The `/` commands and `@` paths seen in a list, by value: what the message
 * shows as chips (FE-92, FE-93), in the composer and in the sent bubble
 * alike. Filled as lists arrive; a draft's token nobody has listed yet is
 * asked for once.
 */
export const known = new Map<string, Suggestion>();

/** The draft tokens already asked for, found or not. */
export const looked = new Set<string>();

const listeners = new Set<() => void>();
let version = 0;

export function remember(items: Suggestion[]) {
  let learnt = false;
  for (const item of items) {
    if (!item.kind) continue;
    known.set(item.value, item);
    learnt = true;
  }
  if (!learnt) return;
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What `token` is, once a list has named it; redraws when one does. */
export function useKnown(token: string): Suggestion | undefined {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return known.get(token);
}
