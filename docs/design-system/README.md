# Design System

The single source of truth for how Lanework looks and behaves. Read the
relevant page before building or changing UI; reuse the documented tokens,
components, and patterns instead of inventing new ones. If a change forces a
deviation or introduces a new reusable pattern, update these docs in the same PR.

## Stack

- **Tailwind CSS v4** (CSS-first config in `src/styles/app.css`)
- **shadcn/ui** — `base-lyra` style, `neutral` base color, on top of **Base UI**
  (`@base-ui/react`) primitives (see `components.json`)
- **Geist** variable font (`@fontsource-variable/geist`)
- **Hugeicons** for iconography (`@hugeicons/react` + `@hugeicons/core-free-icons`)
- **Motion** (`motion/react`) for physics/layout animation, with
  `tw-animate-css` for lightweight CSS fades
- **Tailwind Typography** (`@tailwindcss/typography`) for rendered markdown

## Contents

### Foundations
- [Colors & tokens](./foundations/colors.md) — the oklch token set, semantic
  colors, sidebar tokens, dark mode
- [Typography](./foundations/typography.md) — Geist, the heading/sans split, scale
- [Spacing & radius](./foundations/spacing-radius.md) — radius scale, the
  sharp-vs-soft corner rule, density
- [Icons](./foundations/icons.md) — Hugeicons usage and brand SVGs

### Components
- [Primitives](./components/primitives.md) — Button, Badge, Card, Input, Avatar,
  Dialog, Sheet, Popover, Dropdown Menu, Command, Skeleton, Tooltip, Select
- [Composite components](./components/composite.md) — AppShell, AppSidebar,
  RepoSwitcher, Kanban board/column/card, ReviewDialog, BoardSkeleton

### Patterns
- [Kanban](./patterns/kanban.md) — board, column, and card recipes
- [Status, priority & tags](./patterns/status-priority-tags.md) — the canonical
  color mappings
- [Sidebar navigation](./patterns/sidebar-navigation.md) — nav rows, sections,
  count badges
- [Loading & skeletons](./patterns/loading-skeletons.md) — route pending states

### Cross-cutting
- [Layout](./layout.md) — the app shell, panels, dialogs, reading columns
- [Animation](./animation.md) — Motion conventions, entrance/exit, reduced motion

## Principles

1. **Tokens over literals.** Use semantic classes (`bg-card`, `text-muted-foreground`,
   `ring-border`) — never hard-coded hex/oklch in components.
2. **Reuse recipes.** Cards, rows, badges, and pills have documented shapes.
3. **Two corner languages, on purpose.** Primitives are sharp (`rounded-none`);
   the board/sidebar surfaces are soft (`rounded-xl`/`rounded-2xl`). See
   [spacing & radius](./foundations/spacing-radius.md).
4. **Accessible motion.** Every animation degrades under `prefers-reduced-motion`.
