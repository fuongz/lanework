# Sidebar navigation

Implemented in `src/components/app-sidebar.tsx`. The sidebar is board-contextual:
it shows the current repo's tasks and tags, switches repos from the header, and
always offers help + account actions.

## Structure (top → bottom)

1. **RepoSwitcher** — searchable repo dropdown (active repo name + owner).
2. **Main** (when `nav` present) — `Tasks` (all) and `My tasks` (assigned to the
   viewer), each with a count badge.
3. **Tags** (when `nav` present) — top 5 tags by count + **More** (searchable
   dropdown of all tags). Each row: colored dot · name · count badge.
4. **How to use?** — persistent link to `/guide`.
5. **Account** — `DropdownMenu` (avatar + name → **Logout**, destructive).

When no board is active (e.g. projects home), Main/Tags are replaced by a hint.

## Row recipe

Use the shared classes (exported in `app-sidebar.tsx`):

```ts
rowClass  = "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors"
rowActive = "bg-background font-medium text-foreground shadow-sm ring-1 ring-border"
rowIdle   = "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
```

- Active leading icon: `text-primary`; idle: `text-muted-foreground`.
- Count badge: `ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground`.
- For `Link` active state, prefer `activeProps` / `inactiveProps` to swap
  `rowActive` / `rowIdle` (avoids class conflicts).

## Active logic

Driven by the board route's search params: `Tasks` active when `!mine && !tag`,
`My tasks` when `mine`, a tag row when `tag === name`. The `SidebarNav` object
(counts + sorted tags) is computed in the board page and passed via `AppShell`.
