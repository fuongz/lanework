## Added

- **Session tabs**: every chat you open becomes a tab in the title bar, per project, and stays until you close it, even across restarts. Drag tabs to reorder them, close one with its × or a middle click, and start a new chat with **+**. A run's worker tab shows its task and agent.
- **Tab keys, as in a browser**: **⌘1–⌘8** jump to a tab, **⌘9** to the last one, **⌃Tab** / **⌃⇧Tab** and **⇧⌘]** / **⇧⌘[** move between tabs, **⌘T** opens a new chat and **⌘W** closes the tab (asking first while its agent is still working).
- **Accent colour**: pick Lanework orange, Blue, Indigo, Violet, Pink, Red, Green, Teal or Graphite in **Settings → Appearance**. Buttons, switches, focus rings, links, selected text and the sidebar's hover and selection all follow it, and the window's frame takes a faint tint of it.
- **⌘O** opens the project switcher.

## Changed

- **Switching projects by number is now ⌥⌘1–⌥⌘9**, as ⌘1–⌘9 switch tabs. **New Terminal is ⌃⇧`** (⌘T opens a new chat).
- **Every page's header sits at the top of its own page**, not in the window's title bar, which now holds the tabs. A chat's header reads *Sessions / title* (or *Conductors / name*), with a **…** menu: Rename, Copy session id, Close tab. Files has no header; **⌘P** still opens Go to file.
- **The Sessions panel opens as a dropdown** under its button and closes when you click elsewhere or press Esc.
- **⌘K, Go to file and Search conversations look alike**: grouped results with a line of detail, shortcuts shown as keys, a highlight that slides as you move, and the keys listed underneath.
- **Menus and popovers open with a quick pop** and close at once.
- **A message's actions** (copy, fork, reply…) show when you hover it.
- **The window's frame is slightly see-through** on macOS.
- **The project switcher is more compact**, with a count beside a folded group and a clearer Local badge.
- **Runs are quieter**: one-line header, no progress bar or status badges, smaller marks, and rows start folded.
- The branch button uses the regular font.

## Fixed

- Images dragged in from Finder show their thumbnail again.
- Paths and `@names` inside code blocks in a prompt are no longer turned into file chips.
- A run's durations no longer wrap onto two lines.

**Full Changelog**: https://github.com/fuongz/lanework/compare/v0.5.0...v0.6.0
