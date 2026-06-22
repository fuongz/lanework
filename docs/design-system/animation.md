# Animation

Two layers: **Motion** (`motion/react`) for physics/layout animation on dynamic
surfaces, and **`tw-animate-css`** utilities for lightweight one-shot CSS fades.
Base UI primitives (Dialog, Popover, Menu) bring their own enter/exit transitions.

## Accessibility first

The app is wrapped in `<MotionConfig reducedMotion="user">` (`src/routes/__root.tsx`),
so when a user prefers reduced motion, Motion drops transforms and keeps only
opacity. For CSS animations, pair them with `motion-reduce:animate-none`.

## Motion conventions

**Entrance — stagger by index** (board columns, project/guide cards):

```tsx
<motion.div
  initial={{ opacity: 0, y: 14 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.4, delay: index * 0.07, ease: [0.22, 1, 0.36, 1] }}
/>
```

Cap the stagger delay for large lists (e.g. `Math.min(i, 12) * 0.04`).

**List enter/exit + reflow** (kanban cards under filtering) — wrap the list in
`AnimatePresence mode="popLayout"` and give each item `layout`:

```tsx
<AnimatePresence mode="popLayout">
  {cards.map((card) => (
    <motion.div key={card.path} layout
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.2 }}
      whileHover={{ y: -3 }}>
      <KanbanCard card={card} />
    </motion.div>
  ))}
</AnimatePresence>
```

`key` must be stable (the file path). This is what makes filtered cards animate
out while the rest slide into place.

**Hover** — prefer `whileHover={{ y: -3 }}` on the Motion wrapper for the lift;
keep shadow/ring hover as CSS (`group-hover:shadow-md`) on the inner card.

## CSS (`tw-animate-css`)

For simple, non-interactive entrances (guide body, projects container) use the
utilities + `motion-reduce` guard:

```
animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 ease-out motion-reduce:animate-none
```

Stagger via inline `style={{ animationDelay: \`${i * 60}ms\` }}`.

## When to use which

| Need | Use |
| --- | --- |
| Items entering/leaving/reordering | Motion + `AnimatePresence` + `layout` |
| Springy hover / interactive transforms | Motion `whileHover` / `whileTap` |
| One-shot fade/slide on mount | `tw-animate-css` utilities |
| Modal/popover/menu transitions | Built into the Base UI primitive |

Keep it subtle — short durations (0.2–0.4s), small offsets. Don't animate large
lists with long staggers; cap or drop the per-item delay.
