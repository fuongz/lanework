# Typography

## Font

**Geist** (variable), loaded via `@fontsource-variable/geist` in `app.css` and
applied on `html` (`@apply font-sans`). Two theme families are defined in
`@theme inline`:

- `--font-sans: 'Geist Variable', sans-serif` → `font-sans` (body default)
- `--font-heading: var(--font-sans)` → `font-heading` (headings)

They currently resolve to the same family; `font-heading` exists as a seam so
headings can diverge later without touching every heading. **Use `font-heading`
on page/section titles** so that change stays one-line.

## Scale & usage

The system is compact — default UI text is **small**.

| Context | Classes |
| --- | --- |
| Page title | `font-heading text-2xl font-semibold tracking-tight` |
| Section title | `font-heading text-lg font-semibold` |
| Card title | `font-heading text-sm font-medium` (via `CardTitle`) |
| Body / controls | `text-sm` (buttons, inputs, nav) |
| Card body, descriptions | `text-xs` / `text-xs/relaxed` |
| Metadata, labels, counts | `text-xs` or `text-[11px]` `text-muted-foreground` |
| Uppercase field labels | `text-[11px] font-medium uppercase tracking-wide text-muted-foreground` |
| Keyboard / mono (paths, tags) | `font-mono text-xs` / `text-[11px]` |

## Rendered markdown

Review content renders through `@tailwindcss/typography`. The canonical wrapper
(see `src/components/kanban/review-dialog.tsx`):

```tsx
<article className="prose prose-sm prose-neutral max-w-none dark:prose-invert
  prose-pre:bg-muted prose-pre:text-foreground
  prose-code:before:content-none prose-code:after:content-none">
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
</article>
```

Constrain reading width with `max-w-3xl mx-auto` on the container, not on `prose`.
