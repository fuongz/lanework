# Colors & tokens

All colors are CSS custom properties defined in `src/styles/app.css` and exposed
to Tailwind via `@theme inline`. **Always use the semantic Tailwind class**
(`bg-background`, `text-foreground`, `border-border`, …) — never a raw oklch/hex
value in a component.

## Semantic tokens

| Token | Tailwind class | Use |
| --- | --- | --- |
| `--background` / `--foreground` | `bg-background` / `text-foreground` | App canvas + default text |
| `--card` / `--card-foreground` | `bg-card` / `text-card-foreground` | Card surfaces |
| `--popover` / `--popover-foreground` | `bg-popover` | Dialogs, popovers, menus, command |
| `--primary` / `--primary-foreground` | `bg-primary` / `text-primary` | Brand accent, primary actions, active icons |
| `--secondary` | `bg-secondary` | Secondary buttons, assignee chips |
| `--muted` / `--muted-foreground` | `bg-muted` / `text-muted-foreground` | Subtle fills, labels, metadata |
| `--accent` | `bg-accent` | Hover/focus surfaces in menus |
| `--destructive` | `bg-destructive` / `text-destructive` | Destructive actions (e.g. Logout) |
| `--border` / `--input` / `--ring` | `border-border` / `ring-ring` | Hairlines, inputs, focus rings |

### Sidebar scope

The sidebar has its own token family so it can be tinted independently of the
main canvas: `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`,
`--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-primary`. Classes:
`bg-sidebar`, `text-sidebar-foreground`, `hover:bg-sidebar-accent`, etc.

### Charts

`--chart-1` … `--chart-5` (emerald ramp) are reserved for data viz.

## Brand accent

`--primary` is an emerald/teal — `oklch(0.508 0.118 165.612)` (light) /
`oklch(0.432 0.095 166.913)` (dark). Used sparingly: primary buttons, the active
nav icon, progress bars, step bullets, the corner glow on hover cards.

## Dark mode

Every token has a `.dark` override in `app.css`. Dark mode is class-based
(`@custom-variant dark (&:is(.dark *))`) — toggling `.dark` on a root element
flips the whole palette. Components must rely on tokens so they invert for free;
where a literal color is unavoidable (e.g. tag pills), always pair it with a
`dark:` variant — see [status, priority & tags](../patterns/status-priority-tags.md).

## Adding a token

1. Add the `--name` (and its `.dark` value) under `:root` / `.dark` in `app.css`.
2. Map it inside `@theme inline` (`--color-name: var(--name)`).
3. Use `bg-name` / `text-name` in components. Never re-declare the literal.
