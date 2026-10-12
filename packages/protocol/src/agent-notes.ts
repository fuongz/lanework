// What a project's agent notes say about the Lanework board (FE-30).
//
// One source for two readers: the desktop app writes it into a project's
// AGENTS.md / CLAUDE.md, and the docs site shows it as the snippet to paste.
// Both import it from here, so the two can no longer drift apart.

export const MCP_URL = "https://mcp.lanework.dev/v1";

/** Present in any lanework config or note; the host, not the full URL. */
export const MCP_HOST = "mcp.lanework.dev";

export const AGENT_NOTES = `## Lanework board

Cards for this repo live on Lanework, through the \`lanework\` MCP server.

- Find the board with \`git remote get-url origin\`, then
  \`list_boards({ repo })\`. Never pick a board by its name. If no board is
  linked, ask me which one it is — or whether to make a new one — then call
  \`link_repo\` or \`create_board\`.
- Before creating a card, read \`board_summary\` and reuse the board's
  categories and tags.
- Every \`create_review\` sets \`category\`, \`tags\` and \`priority\`.
- Put decisions in the card's checklist, and start the work only after I
  have ticked them.
- Move cards with \`set_status\`; tick verify steps with \`toggle_item\`.
- A card that touches two or more separate areas gets \`streams\`: one
  sub-agent each, with exact \`owns\` paths and a verify step tagged with
  its key. Shared types go in a \`W0\` the others depend on; at most 4
  streams per wave.
- Handed a card with \`streams\`, you are the lead: run \`dispatch\` wave
  by wave, one sub-agent per stream in its own worktree, each given its
  brief as is. Sub-agents write only in \`owns\`, never commit and never
  call Lanework. After each wave, merge, re-run each stream's checks, tick
  its verify steps and \`checkpoint\` once.`;
