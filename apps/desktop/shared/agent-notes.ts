// What a project's agent notes say about the Lanework board (FE-30).
//
// ⚠️ A COPY of `AGENT_NOTES` in apps/landing/src/routes/docs.mcp.tsx — the
// snippet the docs tell people to paste. Two apps, no shared package between
// them, so tests/readiness.spec.ts reads the landing page and fails the moment
// the two drift apart. Change both together.

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
- Move cards with \`set_status\`; tick verify steps with \`toggle_item\`.`;
