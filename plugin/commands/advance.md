---
description: Advance a lanework review to the next column (or a named status)
argument-hint: <title or path> [to: todo|processing|done|dropped]
allowed-tools:
  - mcp__lanework__list_reviews
  - mcp__lanework__get_review
  - mcp__lanework__lifecycle_status
  - mcp__lanework__set_status
  - mcp__plugin_lanework_lanework__list_reviews
  - mcp__plugin_lanework_lanework__get_review
  - mcp__plugin_lanework_lanework__lifecycle_status
  - mcp__plugin_lanework_lanework__set_status
---

Advance a review on the lanework board.

From "$ARGUMENTS", identify the target card and the destination status:

1. If a `.agents/reviews/….md` path is given, use it directly; otherwise call `list_reviews`
   and match the title (ask which one if it's ambiguous).
2. Decide the destination: if the user named a status (todo/processing/done/dropped), use it.
   Otherwise advance one step: **todo → processing → done**.
3. Before moving **todo → processing**, confirm the checklist is fully approved (every item
   `[x]`) via `get_review` or `lifecycle_status`. If it isn't, warn the user and ask before
   proceeding.
4. Call the lanework MCP `set_status` tool. Report the new status, and — in folder mode —
   the new file path (it changes when the file moves between column folders).
