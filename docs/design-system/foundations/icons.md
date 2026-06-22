# Icons

## Hugeicons (UI icons)

The icon library is **Hugeicons**. Import the renderer from `@hugeicons/react` and
the icon data from `@hugeicons/core-free-icons`:

```tsx
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";

<HugeiconsIcon icon={Search01Icon} className="size-4" />
```

Rules:

- **Size with `className="size-4"`** (or `size-3.5`, `size-5`). The SVG has no
  intrinsic width/height; the class sets both.
- **Color via `text-*`** (`text-muted-foreground` is the default for incidental
  icons; `text-primary` for active/brand). Icons inherit `currentColor`.
- Do **not** import from `lucide-react` — the project migrated off it. Icon names
  end in `…Icon` (e.g. `DashboardSquare01Icon`, `Logout01Icon`, `Tag01Icon`).
- Verify a name exists in `@hugeicons/core-free-icons` before using it (many icons
  have numbered variants like `Folder01Icon`).

### Icons in use (reference)

`DashboardSquare01Icon` (brand/Tasks), `UserIcon` (My tasks), `Tag01Icon`,
`Folder01Icon`, `Search01Icon`, `UnfoldMoreIcon` (switchers), `Logout01Icon`,
`HelpCircleIcon`, `Flag02Icon`, `CheckmarkSquare02Icon`, `Comment01Icon`,
`Calendar03Icon`, `CircleIcon`, `MoreHorizontalIcon`, `ArrowLeft01Icon` /
`ArrowRight01Icon`, `LinkSquare01Icon`, `Copy01Icon` / `Tick02Icon`.

## Brand SVGs

Provider logos live in `src/components/ui/svgs/` (added via the shadcn `@svgl`
registry). They accept `SVGProps`, so size them with `className="size-5"`.

- **Single-color marks** (`ClaudeAiIcon`, `Gemini`) render in any theme.
- **Monochrome marks ship light + dark variants** (`CodexLight`/`CodexDark`,
  `CursorLight`/`CursorDark`). Switch with the theme:

```tsx
function ThemedIcon({ Light, Dark }) {
  return (
    <>
      <Light className="size-5 dark:hidden" />
      <Dark className="hidden size-5 dark:block" />
    </>
  );
}
```

See `src/routes/guide.tsx` for the canonical usage.
