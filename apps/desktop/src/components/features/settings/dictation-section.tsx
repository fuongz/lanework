import { useState } from "react";
import {
  DEFAULT_CORRECTIONS,
  DICTATION_LOCALE_LABELS,
  DICTATION_LOCALES,
  type DictationLocale,
  formatCorrections,
  parseCorrections,
} from "#/../shared/dictation";
import { SettingsPage } from "#/components/shared/settings/settings-page";
import { Button } from "#/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { usePreferences } from "#/stores/preferences";

function LanguageSelect() {
  const locale = usePreferences((state) => state.dictationLocale);
  const setLocale = usePreferences((state) => state.setDictationLocale);
  return (
    <Select
      value={locale}
      onValueChange={(value) => setLocale(value as DictationLocale)}
    >
      <SelectTrigger size="sm" aria-label="Dictation language">
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

/**
 * The fixes applied to what was heard (FE-69/D5), as text: one rule a line.
 * Saved when the field loses focus; Reset goes back to the defaults, and
 * keeps following them as they change.
 */
function CorrectionsEditor() {
  const saved = usePreferences((state) => state.dictationCorrections);
  const save = usePreferences((state) => state.setDictationCorrections);
  const [draft, setDraft] = useState(() =>
    formatCorrections(saved ?? DEFAULT_CORRECTIONS),
  );
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={draft}
        aria-label="Corrections"
        spellCheck={false}
        rows={8}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const rules = parseCorrections(draft);
          save(rules);
          setDraft(formatCorrections(rules));
        }}
        className="font-mono text-[12px] leading-relaxed"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          One rule a line: <code>heard, also heard → meant</code>. Whole words,
          any case.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={saved === null}
          onClick={() => {
            save(null);
            setDraft(formatCorrections(DEFAULT_CORRECTIONS));
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

export function DictationSection() {
  return (
    <SettingsPage
      title="Dictation"
      description="Speak a message instead of typing it: ⌘⇧M or the microphone in the composer. Transcribed on this Mac by macOS; the words wait in the composer for you to send."
      sections={[
        {
          title: "Language",
          rows: [
            {
              label: "Listen for",
              description: "Also in the menu beside the microphone.",
              keywords: "dictation voice speech language vietnamese english",
              control: <LanguageSelect />,
            },
          ],
        },
        {
          title: "Corrections",
          keywords:
            "dictation corrections replace words typecheck commit jargon vocabulary",
          content: <CorrectionsEditor />,
        },
      ]}
    />
  );
}
