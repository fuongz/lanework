import { create } from "zustand";

export type DictationStatus =
  | "idle"
  | "starting"
  | "preparing"
  | "listening"
  | "finishing";

/**
 * The dictation running in some composer, for the island in the shell to show
 * (FE-69): the microphone is open, for how long, how loud — and its stop.
 *
 * ⚠️ Published by the composer's `useDictation`, which owns the session; the
 * island only reads it and calls back. Null when nothing is listening.
 */
export interface LiveDictation {
  status: Exclude<DictationStatus, "idle">;
  levels: number[];
  /** When the microphone opened (ms since epoch), null before it did. */
  since: number | null;
  finish: () => void;
  cancel: () => void;
}

export const useLiveDictation = create<{ live: LiveDictation | null }>(() => ({
  live: null,
}));
