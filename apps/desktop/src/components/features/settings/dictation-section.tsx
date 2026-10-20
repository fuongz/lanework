import {
  Add01Icon,
  ArrowRight02Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CORRECTIONS,
  DICTATION_LOCALE_LABELS,
  DICTATION_LOCALES,
  type DictationCorrection,
  type DictationLocale,
} from "#/../shared/dictation";
import {
  SETTINGS_BUTTON,
  SettingsCard,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Kbd } from "#/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { usePreferences } from "#/stores/preferences";

function LanguageSelect() {
  const locale = usePreferences((state) => state.dictationLocale);
  const setLocale = usePreferences((state) => state.setDictationLocale);
  return (
    <Select
      value={locale}
      onValueChange={(value) => setLocale(value as DictationLocale)}
    >
      <SelectTrigger aria-label="Dictation language">
        <SelectValue>
          {(value: DictationLocale) => DICTATION_LOCALE_LABELS[value]}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {DICTATION_LOCALES.map((value) => (
          <SelectItem key={value} value={value}>
            {DICTATION_LOCALE_LABELS[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One dictionary row while it is edited: what was heard, what was meant. */
interface Entry {
  key: number;
  /** Comma-separated: `thai check, type check`. */
  heard: string;
  meant: string;
}

let nextKey = 0;
const entriesOf = (rules: DictationCorrection[]): Entry[] =>
  rules.map((rule) => ({
    key: nextKey++,
    heard: rule.from.join(", "),
    meant: rule.to,
  }));

/** The rows as rules: blank ones dropped, the heard words split on commas. */
function rulesOf(entries: Entry[]): DictationCorrection[] {
  return entries.flatMap((entry) => {
    const from = entry.heard
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean);
    const to = entry.meant.trim();
    return from.length && to ? [{ from, to }] : [];
  });
}

/**
 * The fixes applied to what was heard (FE-69/D5), one row each: the words
 * dictation hears, and the word you meant. Saved as you leave a field, add
 * or remove a row; Reset goes back to the defaults, and keeps following them
 * as they change.
 *
 * ⚠️ A blank row stays on screen until it is filled in or removed, but it is
 * never saved — a rule with nothing to match is no rule.
 */
function DictionaryEditor() {
  const saved = usePreferences((state) => state.dictationCorrections);
  const save = usePreferences((state) => state.setDictationCorrections);
  const [entries, setEntries] = useState(() =>
    entriesOf(saved ?? DEFAULT_CORRECTIONS),
  );
  const list = useRef<HTMLDivElement>(null);
  const [focusNew, setFocusNew] = useState(false);

  useEffect(() => {
    if (!focusNew) return;
    setFocusNew(false);
    list.current
      ?.querySelector<HTMLInputElement>("[data-entry]:last-child input")
      ?.focus();
  }, [focusNew]);

  const commit = (next: Entry[]) => save(rulesOf(next));
  const change = (key: number, field: "heard" | "meant", value: string) =>
    setEntries((rows) =>
      rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );

  return (
    <SettingsCard>
      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium">Dictation dictionary</span>
          <span className="text-muted-foreground text-[13px] leading-relaxed">
            Words dictation mishears, and what you meant. Separate several with
            commas.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="ghost"
            disabled={saved === null}
            onClick={() => {
              save(null);
              setEntries(entriesOf(DEFAULT_CORRECTIONS));
            }}
          >
            Reset
          </Button>
          <Button
            size="lg"
            className={SETTINGS_BUTTON}
            variant="outline"
            onClick={() => {
              setEntries((rows) => [
                ...rows,
                { key: nextKey++, heard: "", meant: "" },
              ]);
              setFocusNew(true);
            }}
          >
            <HugeiconsIcon
              icon={Add01Icon}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Add entry
          </Button>
        </div>
      </div>
      <div ref={list} className="flex flex-col gap-2 px-4 py-3">
        {entries.length === 0 && (
          <p className="text-muted-foreground text-[13px]">
            No entries. Add one for a word dictation keeps getting wrong.
          </p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.key}
            data-entry=""
            className="flex items-center gap-2"
          >
            <Input
              value={entry.heard}
              placeholder="Heard"
              aria-label="Heard"
              spellCheck={false}
              onChange={(event) =>
                change(entry.key, "heard", event.target.value)
              }
              onBlur={() => commit(entries)}
              className="h-8 min-w-0 flex-[3] text-[13px] md:text-[13px]"
            />
            <HugeiconsIcon
              icon={ArrowRight02Icon}
              className="text-muted-foreground size-4 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <Input
              value={entry.meant}
              placeholder="Meant"
              aria-label="Meant"
              spellCheck={false}
              onChange={(event) =>
                change(entry.key, "meant", event.target.value)
              }
              onBlur={() => commit(entries)}
              className="h-8 min-w-0 flex-[2] text-[13px] md:text-[13px]"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${entry.meant || "entry"}`}
              title="Remove"
              className="text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => {
                const next = entries.filter((row) => row.key !== entry.key);
                setEntries(next);
                commit(next);
              }}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </Button>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

export function DictationSection() {
  return (
    <SettingsPage
      title="Dictation"
      description="Speak a message instead of typing it. It is transcribed on this Mac."
      sections={[
        {
          title: "General",
          rows: [
            {
              label: "Language",
              description: "Also in the menu next to the microphone.",
              keywords:
                "dictation voice speech language vietnamese english listen",
              control: <LanguageSelect />,
            },
            {
              label: "Dictation shortcut",
              description: "Start or stop dictating in the composer.",
              keywords: "dictation shortcut hotkey keybinding cmd shift m",
              control: (
                <Kbd className="h-6 min-w-6 px-1.5 font-mono text-[11px]">
                  ⌘⇧M
                </Kbd>
              ),
            },
          ],
        },
        {
          title: "Dictionary",
          hideTitle: true,
          keywords:
            "dictation dictionary corrections replace words typecheck commit jargon vocabulary heard meant",
          content: <DictionaryEditor />,
        },
      ]}
    />
  );
}
