---
description: Show the lanework board lifecycle status and suggested next actions
argument-hint: "[optional tag/column to focus on]"
allowed-tools:
  - mcp__lanework__lifecycle_status
  - mcp__lanework__list_reviews
  - mcp__plugin_lanework_lanework__lifecycle_status
  - mcp__plugin_lanework_lanework__list_reviews
---

Show the current state of the lanework board.

If "$ARGUMENTS" is empty, call the lanework MCP `lifecycle_status` tool and present:

1. A compact count per column (todo / processing / done / dropped).
2. The **suggested next actions** it returns (cards ready to advance) — one short bullet each,
   with the card title and what to do (e.g. "advance to processing — all boxes checked").
3. If nothing is actionable, say so in one line.

If "$ARGUMENTS" is provided, treat it as a focus filter and call `list_reviews` with it
(as a column, tag, or assignee) instead, then summarize those cards.

Keep the whole response brief.
