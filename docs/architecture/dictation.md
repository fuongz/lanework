# Dictation (FE-69)

Press the mic (or `⌘⇧M`) in the composer, speak, and the words appear in the
input as you talk. ✓ keeps them for you to edit and send; ✕ throws them away.
It **never sends on its own** and never reads answers aloud.

macOS 26 or later only. Recognition runs on the Mac with Apple's
`DictationTranscriber`; the audio never leaves it. On other systems the mic
button is hidden.

## The parts

| Part | Path | Does |
| --- | --- | --- |
| Composer | `src/components/shared/conversation/composer.tsx`, `composer.dictation.tsx` | Remembers the caret, shows the live words, locks the input while listening, handles `Esc`, `Enter` and `⌘⇧M` |
| Island | `src/components/features/shell/dictation-island.tsx`, `src/stores/dictation.ts` | The black pill at the top: red waveform, timer, stop |
| Contract | `shared/dictation.ts` | IPC channels, events, locales, default corrections, `applyCorrections`, `insertDictation` |
| Main | `electron/main/dictation/index.ts` | Checks the system and arguments, starts and stops the helper, turns its lines into events |
| Helper | `native/dictation/main.swift` → `dist/electron/bin/lanework-dictation` | Opens the mic, runs Apple's transcriber, prints results |
| Settings | `src/components/features/settings/dictation-section.tsx` | Language and corrections |

Paths are under `apps/desktop/`.

## One dictation

1. The composer remembers the caret (or selection) and calls `start(locale, hints)`.
2. Main checks macOS 26+, the helper, the locale and the hints, stops any
   other session (only one mic at a time) and spawns the helper.
3. The helper asks for the mic the first time, downloads the language model
   if needed (`preparing`), opens the mic (`listening`), then streams `level`
   about 20 times a second and `text` (`final` plus the still-changing
   `volatile`).
4. Main validates each line, clamps `level` to 0…1, tags it with the session
   and forwards it.
5. The composer drops events from other sessions, applies the corrections and
   shows the live words at the caret. The draft itself changes only on ✓.

| Action | Result |
| --- | --- |
| ✓ or `Enter` | `stop`: the helper closes the mic, waits for the final words and sends `done`; they are inserted at the caret |
| ✕ or `Esc` | The helper is killed; the input is back as it was |
| Leaving the conversation, quitting | The session is cancelled and the mic released |
| The helper dies without `done` | An `exited` error: "Dictation stopped unexpectedly." |
| Mic permission refused | `microphone-denied`, with the way to System Settings |

## Helper protocol

`lanework-dictation --locale vi_VN [--hint word]... [--file audio.wav]`

- **stdout**, one JSON object per line: `preparing`, `listening`,
  `level {value}`, `text {final, volatile}`, `done {text}` (then exit 0),
  `error {code, message}` (then exit 1).
- **stdin**, one command per line: `stop` or `cancel`. EOF on stdin also exits.
- Error codes: `microphone-denied`, `microphone`, `unsupported`, `assets`,
  `engine`, `usage`; main adds `spawn` and `exited`.
- Main trusts neither the helper nor the renderer: locales come from
  `DICTATION_LOCALES`, hints are capped (100 words of 60 characters), and IPC
  goes through `handle()`.

Test without speaking: `sleep 20 | dist/electron/bin/lanework-dictation --locale vi_VN --file sample.wav`
(`sleep` keeps stdin open).

## Corrections

Apple hears English words inside Vietnamese as Vietnamese ("thai check" for
typecheck) and ignores hint lists, so every result goes through a corrections
table, edited in Settings → Dictation:

```text
thai check, ti te check, type check → typecheck
còn beat, cơm mít → commit
```

Matches are whole words, case-insensitive, longest phrase first, applied to the
live words and the final text. Until the user edits the table, the app uses
`DEFAULT_CORRECTIONS` (and gets newer defaults); **Reset** returns to them.

## Why Apple's engine

A comparison on 2026-10-20 (M1, real Vietnamese speech) found Apple's
`DictationTranscriber` exact and fast (0.9 s) on everyday sentences, Whisper
better only at English terms and without live words (and a 550 MB model), and
`SpeechTranscriber` without Vietnamese. Apple only (FE-69/D2); the
corrections table makes up for the terms.

## Build

`scripts/build-dictation.mjs` compiles the helper with `xcrun swiftc` during
`bun run build` and `bun run dev`, only when `main.swift` changed. Without
`swiftc` or off macOS it warns and skips: the app runs without the mic.
`electron-builder.yml` unpacks `dist/electron/bin/**` and adds the microphone
and speech-recognition usage strings.

## Known limits

- English terms are right only once they are in the corrections table.
- Not yet: dictation in PR and issue comments, reading answers aloud, a cloud
  engine.
