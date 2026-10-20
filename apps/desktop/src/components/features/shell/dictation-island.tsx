import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  ISLAND_HOST,
  ISLAND_HOST_TOP,
  ISLAND_MORPH,
  ISLAND_PILL_RADIUS,
  ISLAND_SURFACE,
} from "#/components/shared/agents/harness-island";
import { DictationWaveform } from "#/components/shared/conversation/dictation-waveform";
import { type LiveDictation, useLiveDictation } from "#/stores/dictation";

/** "01:05", as the recording's running time. */
function elapsed(since: number | null, now: number): string {
  const seconds =
    since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whether a dictation is listening — the other islands give way to it. */
export function useDictationUp(): boolean {
  return useLiveDictation((state) => state.live !== null);
}

/**
 * The microphone is open (FE-69): a black capsule in the islands' spot, with
 * the level in red, the running time and a stop — so it is plain from
 * anywhere in the window that Lanework is listening.
 *
 * ⚠️ It outranks every other island while it is up. An update offer or a
 * board notice can wait a minute; an open microphone nobody noticed cannot.
 *
 * ⚠️ Stop keeps the words, like ✓ in the composer: the red square reads as
 * "end the recording", not "throw it away". ✕ and Esc stay in the composer.
 */
export function DictationIsland() {
  const live = useLiveDictation((state) => state.live);
  const reduced = useReducedMotion() ?? false;
  // The last dictation, kept for the island's way out: it shrinks away still
  // showing its time rather than going blank first.
  const last = useRef<LiveDictation | null>(null);
  if (live) last.current = live;
  const shown = live ?? last.current;
  return (
    <div className={ISLAND_HOST} style={{ top: ISLAND_HOST_TOP }}>
      <p className="sr-only" role="status" aria-live="polite">
        {live?.status === "listening" ? "Dictation: listening" : ""}
      </p>
      <AnimatePresence initial={false}>
        {live && shown && (
          <motion.div
            key="dictation"
            data-testid="dictation-island"
            data-status={shown.status}
            transition={reduced ? { duration: 0.2 } : ISLAND_MORPH}
            initial={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.7 }}
            style={{ borderRadius: ISLAND_PILL_RADIUS + 6 }}
            className={ISLAND_SURFACE}
          >
            <Capsule live={shown} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Capsule({ live }: { live: LiveDictation }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const listening = live.status === "listening";
  return (
    <div className="flex h-10 items-center gap-3 ps-4 pe-1.5">
      <DictationWaveform
        levels={live.levels}
        className="text-red-500"
        quietClassName="bg-white/30! text-white"
      />
      <span className="min-w-10 text-right text-[13px] font-medium text-red-500 tabular-nums">
        {live.status === "preparing"
          ? "Preparing…"
          : live.since === null
            ? "00:00"
            : elapsed(live.since, now)}
      </span>
      <button
        type="button"
        aria-label="Stop dictation"
        title="Stop and keep the words"
        disabled={!listening}
        onClick={live.finish}
        className="flex size-7 items-center justify-center rounded-full ring-2 ring-white/90 transition-opacity outline-none focus-visible:ring-white disabled:opacity-50"
      >
        <span className="size-3.5 rounded-[4px] bg-red-500" />
      </button>
    </div>
  );
}
