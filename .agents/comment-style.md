# Comment style (2026-10-21)

The rules every comment in this repo is rewritten to. Only COMMENTS change —
never code, strings, or formatting outside a comment.

## Form, by file type

- **TS / TSX / MJS**
  - A declaration (function, component, const, type, interface, class, and a
    field or member of one) gets a JSDoc block: `/** … */` — one line when it
    fits, otherwise the multi-line form with ` * ` on every line.
  - Inside a body (a function, a JSX tree's logic, an object literal) use `//`
    line comments. Never `/* … */` inside a body.
  - Inside JSX markup use `{/* … */}`, as now.
  - A file header — a comment about the whole module, attached to no
    declaration — is a `//` block at the top. Never a floating `/** */`: an
    editor reads it as the next declaration's JSDoc.
  - Wrap at 80 columns, as the code does.
- **CSS**: `/* … */` only.

## JSDoc content (TSDoc flavour — the types are in the code, never in a tag)

- **Summary first.** The first sentence of every JSDoc is a one-line summary
  of what the thing is or does — it is what an editor's tooltip shows. Any
  explanation goes in a following paragraph, after a blank ` *` line.
- **`@param name` / `@returns`** only when the name and the type do not say
  enough: a unit or meaning the type hides (`folder` is an index, not a
  path), what `null` / `undefined` / an empty result means, a side effect.
  Never on every function; never repeat the type; no `-` after the name.
  `@param` lines come after the prose, then `@returns`, then `@throws`.
- **`@throws`** on a function that deliberately throws to its caller (IPC
  handlers, validators like `slugOf`), saying when.
- **`{@link Symbol}`** when a JSDoc names a symbol of this codebase (a
  function, type, store, component, constant) that a reader may want to jump
  to: `{@link usePreferences}`, `{@link FileListing}`. Members as
  `{@link useFiles | useFiles().open}` only when needed. Keep backticks for
  file names, commands, CLI flags, literal values, and identifiers that are
  not importable from where the comment is (a local variable, a parameter).
  `{@link}` is for JSDoc only, never inside `//` comments.
- `NOTE:` and card ids stay in the prose as below — no `@remarks`, no `@see`.

## Voice

- English. Plain words, short sentences, present tense.
- Say WHY — the constraint, the trap, the reason for a choice. Do not
  restate WHAT the code plainly does.
- One idea per sentence. Cut filler ("deliberately", "on purpose", "exactly",
  "simply", "of course") unless it changes the meaning.
- Prefer a short list (`-`) over a paragraph when a comment carries several
  separate points.

## Markers

- `⚠️` is never used. A comment that started with `⚠️` starts with `NOTE:`
  instead (in JSDoc, the first line: `/** NOTE: … */`). Keep `NOTE:` for a
  real trap — a change there that would cause a bug, a leak or a security
  hole. A plain remark that was only marked `⚠️` loses the marker.
- `TODO:` / `FIXME:` stay as they are.

## Card ids (`FE-66`, `FE-66/D7`, `BE-17`, …)

- Keep an id where it explains a design decision someone may need to trace
  back to its card: "Read on entry and focus, never on a timer (FE-22/D10)."
- Drop it where it only tags the line with the card that wrote it:
  "The tree on the left (FE-66)." → "The tree on the left."
- Never renumber an id. Old ids are mapped in AGENTS.md; leave them as written.

## Remove

- Comments that restate the code next to them.
- History: "used to", "until X", "was moved from", "now" — unless the history
  is the reason the code looks the way it does, then say the reason.
- Commented-out code.
- Comments about things that no longer exist.

## Never touch

- Code, string and template literals, JSX text, imports, formatting.
- Tool directives, exactly as written: `biome-ignore`, `@ts-expect-error`,
  `@ts-ignore`, `eslint-disable`, `#!` shebangs, `@vite-ignore`,
  `webpackChunkName`, `/*#__PURE__*/`, `@jsx…`, `// @ts-check`.
- `@deprecated`, `@param`, `@returns`, `@example` tags — reword their text if
  needed, keep the tag.
- Generated files (`routeTree.gen.ts`, `*.cjs` bundles), `node_modules`,
  `dist`.
- Markdown, JSON and config files.

## Check

`node .agents/comment-check.mjs <files…>` — compiles each file at HEAD and
now with comments stripped; any difference means code changed.
