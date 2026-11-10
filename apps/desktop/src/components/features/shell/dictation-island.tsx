import { useEffect, useState } from "react";
import { ISLAND_PILL_RADIUS } from "#/components/shared/agents/harness-island";
import { DictationWaveform } from "#/components/shared/conversation/dictation-waveform";
import { type LiveDictation, useLiveDictation } from "#/stores/dictation";
import {
  announceIsland,
  ISLAND_PRIORITY,
  useIslandContent,
} from "#/stores/island";

/** "01:05", as the recording's running time. */
function elapsed(since: number | null, now: number): string {
  const seconds =
    since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whether a dictation is listening. */
export function useDictationUp(): boolean {
  return useLiveDictation((state) => state.live !== null);
}

const DICTATION_ISLAND_ID = "dictation";

/**
 * The open microphone on the island, with the level in red, the running time
 * and a stop.
 *
 * It makes it plain from anywhere in the window that Lanework is listening.
 *
 * - It outranks every other content while it is up ({@link ISLAND_PRIORITY}).
 *   An update offer or a board notice can wait a minute; an open microphone
 *   nobody noticed cannot.
 * - Stop keeps the words, like ✓ in the composer: the red square reads as
 *   "end the recording", not "throw it away". ✕ and Esc stay in the
 *   composer.
 *
 * Draws nothing itself: `<IslandHost/>` in the shell does.
 */
export function DictationIsland() {
  const live = useLiveDictation((state) => state.live);
  const said = live?.status === "listening" ? "Dictation: listening" : "";
  useEffect(() => {
    if (said) announceIsland(said);
  }, [said]);
  useIslandContent(
    live
      ? {
          id: DICTATION_ISLAND_ID,
          priority: ISLAND_PRIORITY.dictation,
          tone: "neutral",
          label: "Dictation",
          pillRadius: ISLAND_PILL_RADIUS + 6,
          attributes: {
            "data-testid": "dictation-island",
            "data-status": live.status,
          },
          pill: () => <Capsule live={live} />,
        }
      : null,
  );
  return null;
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
