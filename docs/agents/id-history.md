# Task-id history

Commits, notes and code comments written before two board moves use task ids
that now belong to other cards. The root [AGENTS.md](../../AGENTS.md) points
here; look an id up when its card does not match what the comment describes.

## `.agents/reviews/` imported to the cloud (BE-09)

Until 2026-09-24 cards were also markdown files under `.agents/reviews/`. Every
one of them was imported to the cloud board and the folder was removed; it is
still in git history before that commit.

Some local cards carried a task id the cloud had already given to another card.
Commits and notes written before BE-09 use the **local** id; this is where each
one lives now:

| Local id (old commits) | Card | Cloud id |
| --- | --- | --- |
| BE-05 | Checklist progress trên board list read | **BE-10** |
| BE-06 | Issue detail theo design: activity, comment, assignee | **BE-11** |
| BE-07 | Remote MCP server (packages/db, Hono, OAuth 2.1 + DCR) | **BE-06** |
| FE-09 | Kết nối git repo và quản lý pull request | **FE-12** |
| FE-10 | Pull requests: resizable panels, Summary/Code | FE-10 (unchanged) |
| FE-11 | Summary tab: description, checks, activity | FE-11 (unchanged) |

Every other local id (INF-01, BE-01…BE-04, FE-01…FE-08) is the same card on the
cloud. The cloud's own BE-05, BE-07 and FE-09 are different cards from the
local ones of that id.

## Two boards since the repo split (2026-10-14)

The open-source split (INF-04) left this repo — the desktop app — on the board
it shared with the API and MCP. On 2026-10-14 it moved to a board of its own,
**fuongz/lanework-public**; the API, MCP, landing and db stay on
**fuongz/lanework**.

Every desktop card (INF-01…INF-04, FE-01…FE-59 except FE-09) was re-created on
the new board — its body starts with `ID cũ` — and archived on the old one. The
new board minted its own ids, and FE-09 (landing) stayed behind, so:

| Old id (fuongz/lanework) | New id (fuongz/lanework-public) |
| --- | --- |
| INF-01…INF-04, FE-01…FE-08 | the same |
| FE-10…FE-59 | one lower: FE-10 → **FE-09**, FE-20 → **FE-19**, FE-58 → **FE-57**, FE-59 → **FE-58** |
| BE-*, PD-*, FE-09 | not moved — still on fuongz/lanework |

Commits and code comments written before the move use the **old** ids, and so
does the root AGENTS.md (BE-09, BE-17, BE-19, FE-28, FE-29). The shell's files
(`app-shell.tsx`, `app-sidebar.tsx`, `app.css`, `tests/rail.spec.ts`) were
renumbered to the new ids when FE-58 touched them.
