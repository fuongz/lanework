# Primitives

shadcn `base-lyra` components wrapping Base UI (`@base-ui/react`). They live in
`src/components/ui/`. Add new ones with the shadcn CLI; don't hand-roll
equivalents. All accept `className` (merged with `twMerge`, so later classes win).

## Button — `ui/button.tsx`

`variant`: `default` · `outline` · `secondary` · `ghost` · `destructive` · `link`
`size`: `default` (`h-8`) · `xs` (`h-6`) · `sm` (`h-7`) · `lg` (`h-9`) · `icon` ·
`icon-xs` · `icon-sm` · `icon-lg`

```tsx
<Button variant="ghost" size="icon-sm"><HugeiconsIcon icon={Cancel01Icon} /></Button>
```

Base UI buttons render via the `render` prop for `asChild`-style composition.

## Badge — `ui/badge.tsx`

`variant`: `default` · `secondary` · `outline` · `ghost` · `destructive` · `link`.
Height `h-5`, `rounded-none` by default. Used for: repo Public/Private, branch,
status/priority/tag pills (with local color overrides).

## Card — `ui/card.tsx`

`size`: `default` · `sm` (controls `--card-spacing`). Sharp (`rounded-none`),
`ring-1 ring-foreground/10`. Slots:

`Card` › `CardHeader` (`CardTitle`, `CardDescription`, `CardAction`) · `CardContent` ·
`CardFooter` (has a built-in top divider).

`CardAction` auto-positions to the header's top-right when a description is present.

## Input — `ui/input.tsx`

`h-8`, sharp, full-width. For search/combobox fields inside popovers we use a
custom styled `<input>` or the `Command` input instead (see Command).

## Avatar — `ui/avatar.tsx`

`size`: `default` · `sm` · `lg`. `Avatar` › `AvatarImage` + `AvatarFallback`
(initials). Also exports `AvatarGroup` / `AvatarGroupCount` / `AvatarBadge`.

## Dialog — `ui/dialog.tsx`

`Dialog` › `DialogTrigger` / `DialogContent` (`DialogHeader`, `DialogTitle`,
`DialogDescription`, `DialogFooter`). `DialogContent` wraps Portal + Backdrop +
Popup and ships a close button (`showCloseButton`). Animates via Base UI
data-state classes. The review detail uses a **full-screen** dialog — see
[layout](../layout.md).

## Sheet — `ui/sheet.tsx`

Side panel (`side="right|left|top|bottom"`). Retained as a primitive; the mobile
sidebar (`ui/sidebar.tsx`) uses it. The task detail intentionally uses **Dialog**,
not Sheet.

## Popover — `ui/popover.tsx`

`Popover` › `PopoverTrigger` / `PopoverContent`. `PopoverContent` wraps Portal +
Positioner + Popup and takes `align` / `side` / `sideOffset` plus Popup props.
**Always go through `ui/popover.tsx`** — don't import `@base-ui/react/popover`
directly in feature code. For a searchable list, put a `Command` inside (override
the default padding with `className="gap-0 p-0 overflow-hidden"`).

## Dropdown Menu — `ui/dropdown-menu.tsx`

Base UI `Menu`. `DropdownMenu` › `DropdownMenuTrigger` / `DropdownMenuContent`
(`DropdownMenuItem` with `variant="destructive"`, `DropdownMenuSeparator`,
`DropdownMenuLabel`, sub-menus, checkbox/radio items). Used by the account menu.

## Command — `ui/command.tsx`

`cmdk`-based searchable list: `Command` › `CommandInput` / `CommandList`
(`CommandEmpty`, `CommandGroup`, `CommandItem`). Items show a checkmark when
`data-checked="true"`. Powers the repo switcher and the "More tags" dropdown.

## Skeleton — `ui/skeleton.tsx`

`<Skeleton className="h-4 w-2/3" />` — `animate-pulse bg-muted`. Build loading
placeholders by composing skeletons in the real layout's shape.

## Tooltip — `ui/tooltip.tsx`

Wrapped once at the root via `TooltipProvider` (`src/routes/__root.tsx`).

## Select — `ui/select.tsx`

Base UI select. **`<SelectValue>` renders the raw value by default** — always map
to a label (`<SelectValue>{(v) => OPTIONS.find(o => o.value === v)?.label ?? v}</SelectValue>`)
or pass `items` to the root.
