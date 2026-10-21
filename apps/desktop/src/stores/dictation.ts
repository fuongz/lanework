import { create } from "zustand";

export type DictationStatus =
  | "idle"
  | "starting"
  | "preparing"
  | "listening"
  | "finishing";

/**
 * The dictation running in some composer, for the shell's island to show.
 *
 * It says the microphone is open, for how long, how loud, and how to stop it.
 *
 * The composer's `useDictation` owns the session and publishes it here. The
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
