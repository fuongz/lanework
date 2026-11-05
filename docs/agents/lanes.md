# Board lanes and the card lifecycle

Root `AGENTS.md` § "Review gate for behavior-changing work" lists the lanes in
one line each. This page says what each lane's **role** does, and how a card
moves through Review (BE-23 on the cloud, FE-118 in the desktop app).

## Lanes and roles

A board names its own lanes; what the API and the app act on is each lane's
role. A new board starts with six:

| Lane key | Name | Role | What the role does |
| --- | --- | --- | --- |
| `backlog` | Backlog | `intake` | Where a card lands when no lane is named. |
| `todo` | To-Do | `start` | Plan written, decisions not all ticked. |
| `processing` | In Progress | `active` | Being built. Stamps `startedAt`; shows the agents on it; goes stale after two hours without one (BE-21). |
| `review` | Review | `review` | Built and verified, waiting on a person. No presence, no stamp, never stale. Keeps its checkpoints. |
| `done` | Done | `done` | Shipped. Stamps `completedAt`; clears checkpoints. |
| `dropped` | Archived | `archive` | Superseded or abandoned. Clears checkpoints. |

A cloud board still on the five old default lanes was given the Review lane
by the BE-23 migration; a board whose owner re-shaped its lanes has one only
once they add it. Every rule below keys on the role, so a renamed lane works
the same.

## Moving through Review

1. An agent that has finished and verified a card moves it to the review lane
   (`set_status` → `review`), not to done.
2. A person reads the work. Accepting it moves the card to done.
3. Asking for changes moves the card back to an `active` lane **with a
   reason**:
   - MCP: `set_status` refuses the move without `reason` (at most 2000
     characters).
   - Desktop app: moving the card (the Status menu in issue detail) opens a
     "Request changes" dialog; the reason is required and Cancel leaves the
     card in Review. The app sends it as `reason` on
     `POST /v1/boards/:id/items/:item/move`.
4. The reason is recorded on the move's audit row,
   `diff: { columnKey: [from, to], reason }`. `get_review` and the card read
   return it as `changesRequested` until the card changes lane again; the
   desktop shows it above the description and in the activity feed.

An agent resuming a card should read `changesRequested` first: it is what the
reviewer asked for.

## Local boards

A board kept only on this machine (local mode) gets the Review lane when it is
created; existing local boards keep the lanes they have. A local board keeps
no history, so a send-back there asks for no reason, and the offline MCP's
`set_status` accepts `reason` without storing it.
