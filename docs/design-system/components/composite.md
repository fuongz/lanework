# Composite components

App-specific components built from primitives. They encode the layout and the
Kanban patterns; reuse them rather than re-assembling.

## AppShell — `src/components/app-shell.tsx`

The desktop frame: a soft gray canvas with a rounded panel containing the sidebar
and a main column.

```tsx
<AppShell user={user} repos={repos} active={{ owner, repo }} nav={nav}>
  {/* page header + content */}
</AppShell>
```

| Prop | Purpose |
| --- | --- |
| `user` | `{ name, image }` for the account menu |
| `repos` | repos for the switcher |
| `active` | currently open `{ owner, repo }` (highlights switcher) |
| `nav` | optional `SidebarNav` — renders Main + Tags sections (board context only) |

Used by the board, the projects home (`/`), and the guide (`/guide`).

## AppSidebar — `src/components/app-sidebar.tsx`

Rendered inside `AppShell`. Top: `RepoSwitcher`. Middle (when `nav` is provided):
**Main** (`Tasks`, `My tasks` with count badges) and **Tags** (top 5 + "More").
Always: a persistent **How to use?** link and the **account dropdown** (avatar +
name → Logout). Exports the `SidebarNav` type.

Row recipe (reused for nav items and tags):

```ts
const rowClass  = "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors";
const rowActive = "bg-background font-medium text-foreground shadow-sm ring-1 ring-border";
const rowIdle   = "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
```

## RepoSwitcher — `src/components/repo-switcher.tsx`

Header switcher: `Popover` + `Command` searchable repo list. Shows the active repo
name + owner, opens on click or `/`, navigates to the board on select. `TagMore`
(`src/components/tag-more.tsx`) follows the same Popover+Command recipe for tags.

## Kanban — `src/components/kanban/`

- **KanbanBoard** (`kanban-board.tsx`) — horizontal scroll of four columns; owns
  `COLUMN_META` (label + dot color); groups/sorts cards (newest first).
- **KanbanColumn** (`kanban-column.tsx`) — soft lane (`rounded-2xl bg-muted/40`),
  header = dot + label + count, body = animated card list. Motion entrance +
  `AnimatePresence` for cards (see [animation](../animation.md)).
- **KanbanCard** (`kanban-card.tsx`) — title, assignee avatars, flag + date +
  priority badge, footer (done/total · notes · progress %). See
  [kanban pattern](../patterns/kanban.md).
- **ReviewList** (`review-list.tsx`) — the List tab: rows grouped by status.

## ReviewDialog — `src/components/kanban/review-dialog.tsx`

Full-screen `Dialog` for a review. Header (title + GitHub link), a **metadata
panel** (label/value rows: Status, Priority, Assignees, Created, Progress, Tags,
Last run, then one row per unrecognised frontmatter key — a repo's own custom
fields, humanized label), divider, then the markdown body (frontmatter stripped,
`prose`, `max-w-3xl`).

## BoardSkeleton — `src/components/kanban/board-skeleton.tsx`

Full-shell loading placeholder mirroring AppShell + board, shown as the board
route's `pendingComponent`. See [loading & skeletons](../patterns/loading-skeletons.md).
