---
description: List lanework reviews (optionally filtered) and open one
argument-hint: "[column | tag | assignee]"
allowed-tools:
  - mcp__lanework__list_reviews
  - mcp__lanework__get_review
  - mcp__plugin_lanework_lanework__list_reviews
  - mcp__plugin_lanework_lanework__get_review
---

List reviews on the lanework board.

Call the lanework MCP `list_reviews` tool. If "$ARGUMENTS" is provided, use it as a filter —
match it against a column (todo/processing/done/dropped); otherwise treat it as a tag;
otherwise as an assignee.

Present the results as a short table: **title · column · priority · progress (done/total)**.
Sort by column in lifecycle order, then by date.

If the user then asks to open one, call `get_review` with its path and show the rendered
checklist so they can decide what to tick or advance.
