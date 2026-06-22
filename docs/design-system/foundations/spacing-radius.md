# Spacing & radius

## Radius scale

Base is `--radius: 0.625rem`. Derived tokens (in `@theme inline`):

| Token | Value | Tailwind |
| --- | --- | --- |
| `--radius-sm` | `--radius - 4px` | `rounded-sm` |
| `--radius-md` | `--radius - 2px` | `rounded-md` |
| `--radius-lg` | `--radius` | `rounded-lg` |
| `--radius-xl` | `--radius + 4px` | `rounded-xl` |
| `--radius-2xl` | `--radius * 1.8` | `rounded-2xl` |
| `--radius-3xl` | `--radius * 2.2` | `rounded-3xl` |
| `--radius-4xl` | `--radius * 2.6` | `rounded-4xl` |

## Two corner languages (important)

The codebase deliberately mixes two radii vocabularies:

- **Primitives are sharp.** The `base-lyra` shadcn components (`Button`, `Card`,
  `Input`, `Badge`, …) use `rounded-none`. Keep them sharp when used in dense,
  form-like contexts (e.g. the project listing cards, the guide's tool cards).
- **App surfaces are soft.** The board, sidebar, kanban cards, dialogs, popovers,
  and the app shell use `rounded-xl` / `rounded-2xl` for a friendlier feel.

When composing, override the primitive's radius locally via `className`
(`twMerge` resolves the conflict — later class wins), e.g. a soft card pill:
`<Card className="rounded-xl …">`. Don't change the primitive's default.

Reference radii in practice:

| Surface | Radius |
| --- | --- |
| App shell panel, kanban columns | `rounded-2xl` |
| Kanban cards, popovers, repo cards, code blocks | `rounded-xl` |
| Nav rows, search, tiles, buttons (soft contexts) | `rounded-lg` |
| Pills / chips (status, tags, assignees, counts) | `rounded-full` / `rounded-md` |

## Spacing & density

- The shell sidebar is `w-64`; columns are `w-80` (`shrink-0`).
- Cards use `--card-spacing` (`Card size="sm"` → `spacing(3)`, default → `spacing(4)`).
- Controls are short: buttons/inputs `h-8` (sm `h-7`), badges `h-5`.
- Common gaps: column list `gap-2.5`, board `gap-4`, page sections `space-y-10`.
- Page content padding: `px-6` horizontally; headers `pt-5`.
