// Dictation in the composer (FE-69): speech to text on the Mac, by Apple's
// DictationTranscriber in a helper main spawns. Words go into the composer for
// the user to edit and send; nothing is ever sent by voice.

/** The languages offered in the microphone's menu (FE-69/D6). */
export const DICTATION_LOCALES = ["vi_VN", "en_US"] as const;
export type DictationLocale = (typeof DICTATION_LOCALES)[number];

export const DICTATION_LOCALE_LABELS: Record<DictationLocale, string> = {
  vi_VN: "Tiếng Việt",
  en_US: "English",
};

export function isDictationLocale(value: unknown): value is DictationLocale {
  return DICTATION_LOCALES.includes(value as DictationLocale);
}

/** Hints are words, not documents: what main passes on to the helper. */
export const HINT_MAX = 100;
export const HINT_LENGTH_MAX = 60;

/** What the helper reports, as main forwards it. */
export type DictationEvent =
  | { session: number; type: "preparing" }
  | { session: number; type: "listening" }
  | { session: number; type: "level"; value: number }
  | { session: number; type: "text"; final: string; volatile: string }
  | { session: number; type: "done"; text: string }
  | {
      session: number;
      type: "error";
      /** `microphone-denied`, `unsupported`, `assets`, `engine`, `exited`… */
      code: string;
      message: string;
    };

export const dictationChannels = {
  supported: "dictation:supported",
  start: "dictation:start",
  stop: "dictation:stop",
  cancel: "dictation:cancel",
  event: "dictation:event",
} as const;

export interface DesktopDictationApi {
  /** macOS 26 or later with the helper built in. */
  supported: () => Promise<boolean>;
  /**
   * Open the microphone and start transcribing; answers the session's id,
   * which every event carries. A session still running is cancelled first.
   */
  start: (locale: DictationLocale, hints: string[]) => Promise<number>;
  /** Close the microphone; a `done` event follows with the words. */
  stop: (session: number) => Promise<void>;
  /** Close the microphone and drop the words. */
  cancel: (session: number) => Promise<void>;
  onEvent: (listener: (event: DictationEvent) => void) => () => void;
}

/**
 * A fix applied to what was heard (FE-69/D5): each of `from` becomes `to`.
 *
 * Apple's transcriber ignores the hints it is given, and hears the English a
 * developer drops into Vietnamese as Vietnamese words ("thai check",
 * "còn beat"). These rules put them back.
 */
export interface DictationCorrection {
  from: string[];
  to: string;
}

/** Heard by the spike (2026-10-20) in place of the words on the right. */
export const DEFAULT_CORRECTIONS: DictationCorrection[] = [
  {
    from: ["thai check", "tai check", "ti te check", "ti te che", "type check"],
    to: "typecheck",
  },
  {
    from: ["còn beat", "cơm mít", "cơ mít", "com mít", "côm mít"],
    to: "commit",
  },
  { from: ["post lên", "pút lên", "bút lên"], to: "push lên" },
  { from: ["branch man"], to: "branch main" },
  { from: ["bấp", "bớ"], to: "bug" },
  { from: ["pun ri quét", "pu ri quét", "pul ri quét"], to: "pull request" },
];

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with every rule applied, whole words only and ignoring case — "bấp"
 * is fixed, "bấpbênh" is not. Longer phrases go first, so a rule for
 * "ti te check" wins over one for "ti te".
 */
export function applyCorrections(
  text: string,
  rules: DictationCorrection[],
): string {
  const pairs = rules
    .flatMap((rule) =>
      rule.from.map((from) => ({ from: from.trim(), to: rule.to })),
    )
    .filter((pair) => pair.from)
    .sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const { from, to } of pairs) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(from).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    out = out.replace(pattern, to);
  }
  return out;
}

/**
 * Words put in at a selection, spaced from those either side — monocode's
 * `insertDictation`.
 */
export function insertDictation(
  text: string,
  words: string,
  selection: { start: number; end: number },
): { text: string; cursor: number } {
  const start = Math.min(selection.start, text.length);
  const end = Math.min(Math.max(selection.end, start), text.length);
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (!words) return { text: before + after, cursor: start };
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${words}${trail}`;
  return { text: before + inserted + after, cursor: start + inserted.length };
}
