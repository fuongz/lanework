import {
  ArrowDown01Icon,
  Cancel01Icon,
  Mic01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyCorrections,
  DEFAULT_CORRECTIONS,
  DICTATION_LOCALE_LABELS,
  DICTATION_LOCALES,
  type DictationEvent,
  HINT_MAX,
} from "#/../shared/dictation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { type DictationStatus, useLiveDictation } from "#/stores/dictation";
import { usePreferences } from "#/stores/preferences";
import { DictationWaveform } from "./dictation-waveform";

// The composer's dictation (FE-69): the hook that runs a session, and what the
// composer draws for it — the microphone with its language menu, and the
// level with ✕ and ✓ while listening.

/** How many meter readings the waveform draws, newest on the right. */
export const LEVELS = 28;

let supported: Promise<boolean> | null = null;

/** Asked of main once per window: the answer cannot change while it runs. */
function askSupported(): Promise<boolean> {
  const surface = window.desktop?.dictation;
  if (!surface) return Promise.resolve(false);
  supported ??= surface.supported().catch(() => false);
  return supported;
}

const MESSAGES: Record<string, string> = {
  "microphone-denied":
    "Lanework can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone.",
  unsupported: "This Mac can't transcribe that language.",
  assets: "The speech model could not be downloaded.",
};

/**
 * Dictation for one composer (FE-69): a helper in main listens, and what it
 * has heard so far — corrected by the user's rules (D5) — comes back as
 * `heard`. `finish` hands the final words to `onDone`; `cancel` drops them.
 */
export function useDictation({
  onDone,
  onError,
}: {
  onDone: (words: string) => void;
  onError: (message: string) => void;
}) {
  const locale = usePreferences((state) => state.dictationLocale);
  const saved = usePreferences((state) => state.dictationCorrections);
  const rules = saved ?? DEFAULT_CORRECTIONS;
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [heard, setHeard] = useState("");
  const [levels, setLevels] = useState<number[]>(() => Array(LEVELS).fill(0));
  const session = useRef<number | null>(null);
  /** ✕ before main answered with a session: cancelled as soon as it does. */
  const dropped = useRef(false);
  // The latest callbacks and rules, read by the one event listener.
  const latest = useRef({ onDone, onError, rules });
  latest.current = { onDone, onError, rules };

  useEffect(() => {
    let live = true;
    void askSupported().then((value) => live && setAvailable(value));
    return () => {
      live = false;
    };
  }, []);

  const reset = useCallback(() => {
    session.current = null;
    setStatus("idle");
    setHeard("");
    setLevels(Array(LEVELS).fill(0));
  }, []);

  useEffect(() => {
    const surface = window.desktop?.dictation;
    if (!surface) return;
    return surface.onEvent((event: DictationEvent) => {
      if (event.session !== session.current) return;
      const fix = (text: string) =>
        applyCorrections(text, latest.current.rules);
      switch (event.type) {
        case "preparing":
        case "listening":
          setStatus((current) =>
            current === "finishing" ? current : event.type,
          );
          break;
        case "level":
          setLevels((current) => [...current.slice(1), event.value]);
          break;
        case "text":
          setHeard(fix(`${event.final}${event.volatile}`.trim()));
          break;
        case "done":
          reset();
          latest.current.onDone(fix(event.text));
          break;
        case "error":
          reset();
          latest.current.onError(
            MESSAGES[event.code] ?? (event.message || "Dictation failed."),
          );
          break;
      }
    });
  }, [reset]);

  // Leaving the composer — another conversation, a closed view — lets go of
  // the microphone.
  useEffect(
    () => () => {
      dropped.current = true;
      if (session.current !== null)
        void window.desktop?.dictation.cancel(session.current);
    },
    [],
  );

  const start = useCallback(async () => {
    const surface = window.desktop?.dictation;
    if (!surface || session.current !== null || status !== "idle") return;
    setStatus("starting");
    dropped.current = false;
    const hints = [...new Set(latest.current.rules.map((rule) => rule.to))];
    try {
      const id = await surface.start(locale, hints.slice(0, HINT_MAX));
      if (dropped.current) void surface.cancel(id);
      else session.current = id;
    } catch (error) {
      reset();
      latest.current.onError(
        error instanceof Error ? error.message : "Dictation failed.",
      );
    }
  }, [locale, reset, status]);

  const finish = useCallback(() => {
    if (session.current === null) return;
    setStatus("finishing");
    void window.desktop?.dictation.stop(session.current);
  }, []);

  const cancel = useCallback(() => {
    if (session.current === null) dropped.current = true;
    else void window.desktop?.dictation.cancel(session.current);
    reset();
  }, [reset]);

  // Shown by the island in the shell while the microphone is open, so it is
  // known to be listening from anywhere in the window.
  const since = useRef<number | null>(null);
  if (status === "listening" && since.current === null)
    since.current = Date.now();
  if (status === "idle") since.current = null;
  // ⚠️ Cleared only if it is still this composer's: another one unmounting,
  // or going idle, must not take down the island of the one listening.
  useEffect(() => {
    if (status !== "idle")
      useLiveDictation.setState({
        live: { status, levels, since: since.current, finish, cancel },
      });
    else if (useLiveDictation.getState().live?.cancel === cancel)
      useLiveDictation.setState({ live: null });
  }, [status, levels, finish, cancel]);
  useEffect(
    () => () => {
      if (useLiveDictation.getState().live?.cancel === cancel)
        useLiveDictation.setState({ live: null });
    },
    [cancel],
  );

  return { available, status, heard, levels, start, finish, cancel };
}

/**
 * The composer's right corner while dictating (FE-69): the microphone's
 * level, then ✕ and ✓.
 */
export function DictationBar({
  status,
  levels,
  onCancel,
  onDone,
}: {
  status: DictationStatus;
  levels: number[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const busy = status !== "listening";
  return (
    <div className="flex items-center gap-1.5">
      <DictationWaveform
        levels={levels}
        className="text-muted-foreground pe-1.5"
      />
      <button
        type="button"
        aria-label="Cancel dictation"
        title="Cancel (Esc)"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] border-border flex size-7 items-center justify-center rounded-lg border transition-colors"
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          className="size-3.5"
          strokeWidth={2}
        />
      </button>
      <button
        type="button"
        aria-label="Finish dictation"
        title="Done (Enter)"
        disabled={busy}
        onClick={onDone}
        className="text-foreground hover:bg-foreground/[0.08] border-border flex size-7 items-center justify-center rounded-lg border transition-colors disabled:opacity-50"
      >
        <HugeiconsIcon icon={Tick02Icon} className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * The microphone and, beside it, ▾: the language it listens for (FE-69/D6).
 * Two hit targets side by side, like a split button.
 */
export function DictationButton({ onStart }: { onStart: () => void }) {
  const locale = usePreferences((state) => state.dictationLocale);
  const setLocale = usePreferences((state) => state.setDictationLocale);
  return (
    <div className="text-muted-foreground flex h-7 items-center">
      <button
        type="button"
        aria-label="Dictate"
        title={`Dictate in ${DICTATION_LOCALE_LABELS[locale]} (⌘⇧M)`}
        onClick={onStart}
        className="hover:text-foreground hover:bg-foreground/[0.08] flex size-7 items-center justify-center rounded-lg transition-colors"
      >
        <HugeiconsIcon icon={Mic01Icon} className="size-4" strokeWidth={1.8} />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Dictation language: ${DICTATION_LOCALE_LABELS[locale]}`}
          className="hover:text-foreground hover:bg-foreground/[0.08] aria-expanded:bg-foreground/[0.08] flex h-7 w-4 items-center justify-center rounded-md transition-colors outline-none"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3"
            strokeWidth={2}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          sideOffset={6}
          className="w-44 p-1"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs">
              Dictation language
            </DropdownMenuLabel>
            {DICTATION_LOCALES.map((entry) => (
              <DropdownMenuItem
                key={entry}
                onClick={() => setLocale(entry)}
                className="justify-between rounded-lg text-[13px]"
              >
                {DICTATION_LOCALE_LABELS[entry]}
                {entry === locale && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    className="size-3.5"
                    strokeWidth={2}
                  />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
