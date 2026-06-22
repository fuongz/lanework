# Layout

## App shell

`AppShell` (`src/components/app-shell.tsx`) is the desktop frame:

```
bg-neutral-200/60 (dark: neutral-900)  ← soft canvas, p-2/p-3
└── rounded-2xl border bg-background shadow-sm  ← the panel, h-full, overflow-hidden
    ├── AppSidebar   w-64 shrink-0 border-r bg-sidebar
    └── <main>       flex-1 min-w-0 flex-col   ← page header + content
```

Pages render their own header + scroll area inside `<main>`. Keep `min-w-0` on
flex children that contain truncating text.

## Page header

Consistent across board / projects / guide:

```tsx
<div className="px-6 pt-5">
  <div className="text-sm text-muted-foreground">{eyebrow}</div>
  <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">{title}</h1>
  {/* optional tabs: border-b row of rounded-t buttons; active = bordered bg-background */}
</div>
```

## Scroll model

The shell panel is fixed height (`h-screen` minus the canvas padding). Scrolling
happens **inside** regions: the board scrolls horizontally (`overflow-x-auto`),
columns scroll vertically, list/guide bodies use `overflow-y-auto`. The page
itself never scrolls — avoid `min-h-screen` content inside the shell.

## Dialogs

- **Full-screen review dialog** (`ReviewDialog`): `DialogContent` overridden to
  `h-screen max-h-screen w-screen max-w-none rounded-none border-0 p-0`, as a flex
  column — pinned header + metadata panel, scrollable body.
- Body content is centered in a `max-w-3xl` reading column.
- Standard (non-full-screen) dialogs keep the primitive's centered, rounded,
  `max-w-md` default.

## Reading width

Long-form content (markdown, the guide) is constrained with `mx-auto max-w-3xl`
on the container — not on the `prose` element — so the surrounding chrome can be
full width while text stays readable.

## Responsiveness

The shell targets desktop. The project/guide grids use
`sm:grid-cols-2 lg:grid-cols-3`. A mobile sidebar primitive exists
(`ui/sidebar.tsx`, Sheet-based) but the main flows assume a wide viewport.
