---
description: Check or uncheck a checklist item in a lanework review
argument-hint: <title or path> :: <item number or text> [| note]
allowed-tools:
  - mcp__lanework__list_reviews
  - mcp__lanework__toggle_item
  - mcp__plugin_lanework_lanework__list_reviews
  - mcp__plugin_lanework_lanework__toggle_item
---

Toggle a checklist item on a lanework review.

Parse "$ARGUMENTS" into: the target card (a path or a title), which item (a 1-based number
**or** some text to match), and an optional note (after a `|`).

1. Resolve the card's path — use `list_reviews` to match a title if a path wasn't given.
2. Call the lanework MCP `toggle_item` tool with `index` (if a number was given) or `match`
   (the item text). Pass `checked: true` unless the user clearly wants to uncheck it, and
   include `note` if they provided one.
3. Report the updated progress (done/total). If a `todo` card just reached 100%, suggest
   `/lanework:advance` to move it into processing.
