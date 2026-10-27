// A window's remembered UI preferences, in `localStorage`, that never throw.
//
// NOTE: Storage can be unavailable (a locked profile, a full quota, a test
// page) and both reading and writing it then throw. A preference that forgets
// is an annoyance; an exception during render is a blank window. So every
// read and write is wrapped, and a write that cannot persist is kept in
// memory for the rest of the session instead of being lost at once.
//
// Values are strings: each caller keeps its own key and format, and parses
// and validates what it reads back.

/** Writes that could not reach storage, newest first over storage itself. */
const memory = new Map<string, string | null>();

/** The value saved under `key`, or null when there is none or no storage. */
export function readStored(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Save `value` under `key`; null removes it. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}
