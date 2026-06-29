---
description: Create a new lanework review checklist (a todo card) for a piece of work
argument-hint: <short title of the work to review>
allowed-tools:
  - mcp__lanework__create_review
  - mcp__plugin_lanework_lanework__create_review
---

Create a new review on the lanework board for: **$ARGUMENTS**

Use the lanework MCP server's `create_review` tool:

- Use "$ARGUMENTS" as the `title`. If it is empty, ask the user for a one-line title first.
- Infer sensible `tags` and a `priority` (`low` | `medium` | `high`) from the title and the
  recent conversation. If unsure, leave them out.
- For `body`, write a short `## Decisions` section with 2–5 concrete, reviewable `- [ ]`
  items capturing the real choices in this work. For mutually-exclusive options, nest them
  under a `Pick one:` bullet and mark the default `(Recommended)`. Keep items specific —
  these are exactly what the user will approve.
- Leave `status` as the default (`todo`).

After it is created, report the new file path and a one-line summary of the decisions, then
tell the user to review and tick the items (or run `/lanework:status` to see the board).
