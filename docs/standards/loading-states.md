# Loading states: skeletons, not sentences

**Rule:** any pane, list, panel, dialog body or row value that is still being
read draws a **skeleton** shaped like what is coming. It never draws a line of
text like "Reading the history…" or "Loading…".

A sentence in an empty pane only says that something is happening. A skeleton
shows what is coming and where it will land, so the first real paint does not
jump.

## What to use

All of these are in `apps/desktop/src/components/shared/loading/skeletons.tsx`:

| Coming | Use |
| --- | --- |
| A whole Repository-style screen (side list + pane), before its source is read | `SplitSkeleton` (`lines={2}` for commit/PR-style rows) |
| A list: files, settings rows, skills, folders, fonts | `ListSkeleton` (`lines={1}`) |
| A list of two-line rows: commits, pull requests | `ListSkeleton lines={2}` |
| The next page of an infinite list | `ListSkeleton rows={2}` at the end of the list |
| A file, diff, commit or document | `DocumentSkeleton` (`code` for source and diffs) |
| A conversation | `ConversationSkeleton` |
| One value inside a row ("1 account", a version) | `TextSkeleton` |
| Board, issue, properties, project list | `shared/board/skeletons.tsx` |

Something with a shape none of these fit gets its own skeleton, built from
`ui/skeleton` and added to `skeletons.tsx` if a second screen will use it.

## Requirements for a skeleton

1. **`role="status"` and a real `aria-label`.** The label is the sentence the
   skeleton replaced, without the "…" ("Reading the history"). A screen reader
   gets nothing from grey bars alone.
2. **Sized to the real content.** Row heights, the 280px side list and the
   paddings match what replaces it.
3. **Stable widths.** Use a fixed table of widths, never `Math.random`. A
   placeholder that reshuffles on every render flickers.
4. **No spinner on top of it.** Use a skeleton or a spinner, not both. The
   only spinners are the startup screen and an icon spinning inside a button
   that is doing something (Refresh).

## Not covered by this rule

- **A button's label while its action runs:** `Fetching…`, `Checking…`,
  `Reading…` on the button that was clicked. The control stays where it is,
  so there is no layout to hold.
- **A menu item standing in for its submenu:** "Loading commits…" as a
  disabled `DropdownMenuItem`.
- **Errors and empty states.** Those are messages (`RepoMessage`, `Empty`),
  not loading states. Never show an empty state ("No commits yet") while the
  read is still running. That is a loading state, so it gets a skeleton.

## The gate

`node scripts/audit-loading.mjs` runs as part of `bun run lint` and so as
part of `bun run gate`. It fails when a `<p>` or `<div>` contains nothing but
a `Reading…`, `Loading…`, `Checking…` or `Fetching…` sentence. It cannot catch
every phrasing. A sentence built in a string variable passes it, and review
still has to catch that.

Known leftovers, typed as strings and so not yet skeletons: the `Checking…`
descriptions of rows in Settings › Agents (`harness-section.tsx`).
`SettingsRowSpec.description` is a `string` because the settings search
matches against it.
