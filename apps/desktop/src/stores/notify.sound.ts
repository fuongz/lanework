import { usePreferences } from "#/stores/preferences";
import type { NotifyType } from "./notify";

/** One note: its pitch, when it starts after the first, and how long it rings. */
interface Note {
  hz: number;
  at: number;
  length: number;
}

/**
 * Each status as a figure of notes, in seconds.
 *
 * Success rises a fourth, error falls a fourth, warning taps one note twice,
 * info is one note. Loading has none: it is a wait, not news.
 */
const FIGURES: Record<Exclude<NotifyType, "loading">, Note[]> = {
  success: [
    { hz: 659.25, at: 0, length: 0.12 },
    { hz: 880, at: 0.09, length: 0.22 },
  ],
  error: [
    { hz: 440, at: 0, length: 0.14 },
    { hz: 329.63, at: 0.11, length: 0.26 },
  ],
  warning: [
    { hz: 587.33, at: 0, length: 0.09 },
    { hz: 587.33, at: 0.13, length: 0.11 },
  ],
  info: [{ hz: 783.99, at: 0, length: 0.2 }],
};

/** Quiet: a cue under the work, not an alarm. */
const PEAK_GAIN = 0.06;
const ATTACK_S = 0.008;

let context: AudioContext | null = null;

/**
 * Play a toast's status as a short synthesized figure, when the island sound
 * preference is on.
 *
 * - No audio files: an oscillator per note through its own gain envelope,
 *   a quick attack and an exponential fall, so nothing clicks.
 * - The `AudioContext` is made on the first sound and kept for the window's
 *   life; making one per toast leaks them.
 * - NOTE: Chromium keeps audio locked until the page has had a click or a key
 *   press. A sound asked for before that is lost, not queued: a late cue
 *   would describe something else.
 */
export function playNotifySound(type: NotifyType): void {
  if (type === "loading") return;
  if (!usePreferences.getState().islandSound) return;
  if (typeof AudioContext === "undefined") return;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
    const start = context.currentTime + 0.01;
    for (const note of FIGURES[type]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type === "error" ? "triangle" : "sine";
      oscillator.frequency.value = note.hz;
      const from = start + note.at;
      const to = from + note.length;
      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, from + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(0.0001, to);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(from);
      oscillator.stop(to + 0.02);
      oscillator.onended = () => gain.disconnect();
    }
  } catch {
    // A sound is a nicety: a window without audio still shows the toast.
  }
}
