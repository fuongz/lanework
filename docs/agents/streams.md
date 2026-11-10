# Running a card with streams (BE-19)

Moved out of [AGENTS.md](../../AGENTS.md) to keep it under its 12k-character
cap. AGENTS.md says when to split a card into streams; this is how the lead
runs one.

**Running a card with streams.** `get_review` returns `streams` and
`dispatch: { waves, briefs }`; the agent that got the card is the **lead**:

1. For each wave, spawn every stream of the wave in **one** turn (Claude Code:
   several `Agent` calls in one message; Codex: its sub-agents), each in its own
   git worktree from the current HEAD unless the stream is `shared`. Hand each
   sub-agent `dispatch.briefs[key]` verbatim. No sub-agents? Run the streams
   one by one in wave order.
2. Sub-agents write only inside `owns`, may build and test in their own
   worktree, and report the files they changed and the checks they ran. They
   **never** call the Lanework MCP and never commit.
3. After the wave, the lead merges each worktree into the main checkout (3-way
   per file against the base), reverts anything outside `owns`, re-runs the
   stream's checks, ticks that stream's verify items, and calls `checkpoint`
   **once** for the wave.
4. After the last wave, the lead runs the untagged verify items.

Only the lead writes to the card. On **resume** (BE-17), re-dispatch only the
streams whose verify items are not all ticked. A card without streams works
as before: one agent, end to end.
