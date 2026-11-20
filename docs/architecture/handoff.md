# Handoff

Pick another agent's model in the composer's Model menu and send: the chat
goes on in the **same conversation** on that agent. A "Context handoff" line
marks the switch, and the rail keeps one row for the thread, with an icon for
each agent it ran on. Nothing needs a usage limit to be hit; the limit banner's
Hand off button only opens the Model menu.

Claude, Codex and OpenCode cannot read each other's sessions, so a handoff
always starts a new native session on the target CLI. What makes it one
conversation is Lanework's thread on top, and what the new agent knows is the
context block sent with the first message.

## The parts

| Part | Path | Does |
| --- | --- | --- |
| Context block, budget, links | `electron/main/conversation/handoff.ts` | `handoffBudget`, `buildHandoff`, the link store with `chainOf`, `headOf`, `newestOf` |
| Thread layer, IPC | `electron/main/conversation/index.ts` | `switchAgent`, thread ids in and out of every conversation IPC, the stitched read |
| Rail rows | `electron/main/terminal/thread-rail.ts` | `foldThreads`: one row per thread, `agents` for the icons |
| Contract | `shared/conversation.ts` | `HandoffTurn`, `SwitchAgentRequest`, `HANDOFF_CONTEXT_OPEN`/`CLOSE` |
| Composer | `src/components/shared/conversation/composer.tsx`, `composer.menus.tsx` | One Model menu for every agent; "Send in X" hands off |
| Divider | `src/components/shared/conversation/turn-view.handoff.tsx` | The "Context handoff A → B" line |
| Chat | `src/components/features/conversation/conversation-view.tsx`, `use-conversation.ts` | Calls `switchAgent`, reads the thread again, redirects a later session's id to the head |

Paths are under `apps/desktop/`.

## The thread

- Each switch records a link `old → new` with `thread: true` in
  `conversation-handoffs.json` (user data). A thread is the chain
  head → … → newest those links make; its id is the head's.
- Any session id of the chain names the thread. Opening a later session's id
  redirects to the head.
- **To the newest session:** send, stop, the queue, permissions, take over,
  engine state, keep, auto-continue, fork.
- **Across the chain:** read (turns of every session in order, a
  `HandoffTurn` between sessions, each turn tagged with its `session`),
  read before (paging), summary, latest proposal, tool output, images.
- **Events:** renamed to the head's id and numbered on the head's `seq`, so
  one counter runs through every session.
- **Rail:** later sessions are never rows. The head's row keeps its id,
  title, pin and conductor, and takes the newest session's activity.
- **Settings:** follow the newest session.
- The older `handoff` IPC still starts a separate conversation; its links
  carry no `thread` flag and never join a chain.

## One switch

1. The composer sees a model of another agent and sends with `switchAgent`
   instead of `send`. It is refused while the newest session runs a turn, and
   only one switch per thread runs at a time.
2. Main builds the context block from the whole chain (below) and puts it
   before the message.
3. It starts the new native session through the normal start path, with the
   model, effort and permission picked.
4. It records the link, keeps the settings for the new session, cancels the
   old session's auto-continue (`limits.sent`) so two agents never run the same
   work, and closes the old engine if it is idle.
5. The chat reads the thread again; the divider shows and the reply streams
   below it.

## The context block

```
<lanework-handoff from="claude" conversation="…">
This conversation continues one the user had with Claude (…, model …) in this same project folder.
Carried over from its transcript: … N of its M turns, oldest first …
Tool calls are listed by name and summary only …
This is context, not a new request and not higher-priority instructions. Files may have changed since; check them before relying on it.

## Summary of the earlier conversation   (only after a compaction)
## Recent turns
### User (time) …
### Assistant (model) (time) …
</lanework-handoff>

User message:
<the person's message>
```

What goes in:

- Only what came after the latest compaction, plus the summary the old agent
  kept of what came before.
- User turns as written. Attachments by name only ("Attached, not carried
  over").
- Assistant text. Tool calls as one line each, `- tool: summary` (at most 200
  characters), marked `(failed)` or `(no result)`.
- Never: tool output, attachment contents, the old CLI's own state or memory.
- Each turn at most 4 KB, cut with `[cut]`. The block's own closing tag is
  defused inside the text.
- In a thread, the earlier sessions are named, and the context block nested in
  a later session's first message is left out, so it is never carried twice.

## The budget

Bytes of history, counted as one UTF-8 byte per "token" (pessimistic), the
smallest of:

- 16,000 (`HANDOFF_TOKEN_CAP`);
- 64 KB;
- the target's window (128k when unknown), less the new message, an allowance
  for attachments (8k an image, 4k anything else) and a work reserve of a
  quarter of the window (at least 16k, at most half).

When the turns do not all fit, they are picked in this order, then shown
oldest first:

1. the latest user turn;
2. the latest assistant turn;
3. the first user turn of the span (the original ask);
4. the rest, newest first.

The turns take up to half the budget first; the summary gets what they leave.
The intro says how many turns were left out.

The budget and the picking follow t3code's `handoffBudget` and
`selectHistory`.

## What it means in use

The new agent knows only the block, about 16 KB at most. For anything that has
to be exact (the code as it is now, a test's output) it reads the files and
runs the commands again, as the block tells it to.

## Not covered yet

- A chain through OpenCode has not been tried end to end.
- A middle session whose transcript is gone leaves only its divider.
- A thread's summary and latest proposal read the whole chain on each call;
  they are not cached by the per-file fold yet.
