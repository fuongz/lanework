// lanework MCP server (stdio).
//
// Claude (or any MCP client) launches `lanework mcp`. This:
//   1. exposes tools the agent calls to read/update the repo's .agents/reviews,
//   2. optionally boots the web dashboard + opens the browser.
//
// STDIO PROTOCOL RULE: stdout carries the JSON-RPC stream, so nothing else may
// write to it. All logs go to stderr, and the dashboard runs as a *child*
// process with its stdout ignored — guaranteeing a clean protocol channel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const COLUMNS = ["todo", "processing", "done", "dropped"];

// The standalone fs data layer (bundled from packages/shared/src/lib/local-fs.ts).
const libUrl = new URL("./dist-local/reviews-lib.mjs", import.meta.url).href;
const {
  listLocalReviewCards,
  getLocalCardContent,
  saveLocalCardContent,
  getLocalCostEstimate,
  localRepoName,
  localRoot,
  loadLocalBoardConfig,
  createLocalReview,
  planLocalReview,
  setLocalReviewStatus,
  toggleLocalReviewItem,
  updateLocalReviewMeta,
} = await import(libUrl);

const PRIORITIES = ["low", "medium", "high"];

function log(...args) {
  console.error("[lanework-mcp]", ...args);
}

/** Spawn the dashboard (cli.mjs) as a child whose stdout can't taint our protocol. */
function startDashboard(dir) {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, dir], { stdio: "ignore" });
  child.on("error", (e) => log("dashboard failed to start:", e.message));
  const kill = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("exit", kill);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      kill();
      process.exit(0);
    });
  }
  log("dashboard launching for", dir);
}

const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

/** Trim a full card down to the fields an agent cares about. */
function summarizeCard(c) {
  return {
    path: c.path,
    column: c.column,
    title: c.title,
    date: c.date,
    priority: c.priority,
    tags: c.tags,
    assignees: c.assignees,
    progress: { done: c.stats.done, total: c.stats.total, notes: c.stats.notes },
  };
}

export async function startMcp({ dir = process.cwd(), dashboard = true } = {}) {
  process.env.LANEWORK_DIR = dir;
  if (dashboard) startDashboard(dir);

  const server = new McpServer(
    { name: "lanework", version: "0.3.1" },
    {
      instructions:
        "lanework drives an AI-Driven Development Lifecycle through a repo's .agents/reviews board. " +
        "Lifecycle: create_review (inception → a `todo` checklist of decisions) → the user/agent ticks " +
        "items with toggle_item → set_status advances todo → processing → done (or dropped). Use " +
        "lifecycle_status to see what's actionable, list_reviews/get_review to read, and update_review " +
        "to set priority/tags/assignees. Prefer these tools over save_review (raw whole-file write).",
    },
  );

  server.registerTool(
    "list_reviews",
    {
      title: "List reviews",
      description:
        "List review cards from the repo's .agents/reviews folder. Each card has a column " +
        "(todo/processing/done/dropped), title, priority, tags, assignees, date and checklist progress. " +
        "Optionally filter by column, tag, or assignee.",
      inputSchema: {
        column: z.enum(COLUMNS).optional().describe("Only this column"),
        tag: z.string().optional().describe("Only cards with this tag"),
        assignee: z.string().optional().describe("Only cards assigned to this person"),
      },
    },
    async ({ column, tag, assignee }) => {
      let cards = await listLocalReviewCards();
      if (column) cards = cards.filter((c) => c.column === column);
      if (tag) cards = cards.filter((c) => c.tags.includes(tag));
      if (assignee) cards = cards.filter((c) => c.assignees.includes(assignee));
      return ok({ repo: localRepoName(), count: cards.length, reviews: cards.map(summarizeCard) });
    },
  );

  server.registerTool(
    "get_review",
    {
      title: "Get review",
      description: "Read the full markdown of one review file by its repo-relative path.",
      inputSchema: {
        path: z.string().describe("e.g. .agents/reviews/todo/2026-06-21-foo.md"),
      },
    },
    async ({ path }) => {
      if (!path.startsWith(".agents/reviews/") || !path.endsWith(".md")) {
        return { isError: true, content: [{ type: "text", text: "path must be under .agents/reviews/ and end in .md" }] };
      }
      try {
        return ok(await getLocalCardContent(path));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not read ${path}: ${e.message}` }] };
      }
    },
  );

  server.registerTool(
    "board_summary",
    {
      title: "Board summary",
      description: "Counts of reviews per column plus aggregate checklist progress for the current repo.",
    },
    async () => {
      const cards = await listLocalReviewCards();
      const byColumn = Object.fromEntries(COLUMNS.map((c) => [c, 0]));
      let done = 0;
      let total = 0;
      for (const c of cards) {
        byColumn[c.column]++;
        done += c.stats.done;
        total += c.stats.total;
      }
      return ok({ repo: localRepoName(), root: localRoot(), total: cards.length, byColumn, checklist: { done, total } });
    },
  );

  server.registerTool(
    "save_review",
    {
      title: "Save review",
      description:
        "Overwrite a review file with new markdown (e.g. to check off items or move work forward). " +
        "Creates/updates the file at the given .agents/reviews path. Use with care — it writes to disk.",
      inputSchema: {
        path: z.string().describe("e.g. .agents/reviews/processing/2026-06-21-foo.md"),
        content: z.string().describe("Full new markdown content of the file"),
      },
    },
    async ({ path, content }) => {
      if (!path.startsWith(".agents/reviews/") || !path.endsWith(".md")) {
        return { isError: true, content: [{ type: "text", text: "path must be under .agents/reviews/ and end in .md" }] };
      }
      try {
        await saveLocalCardContent(path, content);
        return ok(`saved ${path} (${content.length} bytes)`);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not save ${path}: ${e.message}` }] };
      }
    },
  );

  // ── Lifecycle tools ───────────────────────────────────────────────────────

  server.registerTool(
    "create_review",
    {
      title: "Create review",
      description:
        "Inception: create a new review checklist card. Lands at .agents/reviews/<date>/NN-<slug>.md " +
        "with a status: field (or under the status folder when the board is folder-mode). Returns the " +
        "new file path. Provide a markdown `body` of decisions as `- [ ]` items, or omit it for a starter template.",
      inputSchema: {
        title: z.string().describe("Short review title, e.g. 'Add rate limiting to the public API'"),
        status: z.enum(COLUMNS).optional().describe("Starting column (default: todo)"),
        priority: z.enum(PRIORITIES).optional().describe("low | medium | high"),
        tags: z.array(z.string()).optional().describe("e.g. ['auth','api']"),
        assignees: z.array(z.string()).optional().describe("GitHub logins"),
        date: z.string().optional().describe("YYYY-MM-DD for the card's date folder (default: today)"),
        body: z.string().optional().describe("Markdown after the heading: decisions as `- [ ]` items, context, etc."),
      },
    },
    async (args) => {
      try {
        return ok(await createLocalReview(args));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not create review: ${e.message}` }] };
      }
    },
  );

  server.registerTool(
    "plan_review",
    {
      title: "Write review plan",
      description:
        "Fill in a review card's checklist in the canonical house format. Preserves the card's frontmatter, " +
        "then writes the `# Review:` heading, an optional `context` paragraph, the standard 'How to review' line, " +
        "and a `## Decisions` list rendered as `- [ ] **D1.** …`. PREFER THIS over save_review for planning — " +
        "it guarantees the file shape so it matches every other card. Pass each decision as plain text (no " +
        "leading `- [ ]` or `**Dn.**` — those are added for you).",
      inputSchema: {
        path: z.string().describe("Repo-relative path of the review file to fill in"),
        decisions: z
          .array(z.string())
          .min(1)
          .describe("5–10 decisions/steps to approve, each as plain text (one checklist item per entry)"),
        context: z.string().optional().describe("1–2 sentence context paragraph placed under the heading"),
        title: z.string().optional().describe("Override the heading title (default: keep the card's existing title)"),
      },
    },
    async ({ path, decisions, context, title }) => {
      try {
        return ok(await planLocalReview(path, { decisions, context, title }));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not write plan: ${e.message}` }] };
      }
    },
  );

  server.registerTool(
    "set_status",
    {
      title: "Set status",
      description:
        "Advance a review through the lifecycle (todo → processing → done, or dropped). In the default " +
        "frontmatter mode this rewrites the `status:` field in place (path is unchanged); in folder mode it " +
        "moves the file into the new column folder (path changes — use the returned path afterwards).",
      inputSchema: {
        path: z.string().describe("Repo-relative path of the review file"),
        status: z.enum(COLUMNS).describe("New column"),
      },
    },
    async ({ path, status }) => {
      try {
        return ok(await setLocalReviewStatus(path, status));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not set status: ${e.message}` }] };
      }
    },
  );

  server.registerTool(
    "toggle_item",
    {
      title: "Toggle checklist item",
      description:
        "Check or uncheck one checklist item in a review, selected by 1-based `index` (across all items) or " +
        "by `match` text. Optionally attach a `> note`. Returns the updated checklist progress. Use this to " +
        "approve decisions instead of rewriting the whole file.",
      inputSchema: {
        path: z.string().describe("Repo-relative path of the review file"),
        index: z.number().int().positive().optional().describe("1-based item position across all checkboxes"),
        match: z.string().optional().describe("Case-insensitive text to find the item (used if index is omitted)"),
        checked: z.boolean().optional().describe("Force checked/unchecked (default: flip current state)"),
        note: z.string().optional().describe("Optional reviewer note added as a `> …` line under the item"),
      },
    },
    async ({ path, index, match, checked, note }) => {
      try {
        return ok(await toggleLocalReviewItem(path, { index, match, checked, note }));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not toggle item: ${e.message}` }] };
      }
    },
  );

  server.registerTool(
    "update_review",
    {
      title: "Update review metadata",
      description:
        "Patch a review's priority, tags, and/or assignees in frontmatter (does not move the file or change " +
        "status — use set_status for that). Only the provided fields change.",
      inputSchema: {
        path: z.string().describe("Repo-relative path of the review file"),
        priority: z.enum(PRIORITIES).optional().describe("low | medium | high"),
        tags: z.array(z.string()).optional().describe("Replaces the tag list"),
        assignees: z.array(z.string()).optional().describe("Replaces the assignee list"),
      },
    },
    async ({ path, priority, tags, assignees }) => {
      try {
        return ok(await updateLocalReviewMeta(path, { priority, tags, assignees }));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `could not update review: ${e.message}` }] };
      }
    },
  );

  server.registerTool(
    "lifecycle_status",
    {
      title: "Lifecycle status",
      description:
        "A workflow view of the board: cards per phase plus suggested next actions — todo reviews whose boxes " +
        "are all checked (ready to advance to processing) and processing reviews that are 100% done (ready to " +
        "ship to done). Use this to decide what to do next.",
    },
    async () => {
      const config = await loadLocalBoardConfig();
      const cards = await listLocalReviewCards();
      const slim = (c) => ({
        path: c.path,
        title: c.title,
        progress: { done: c.stats.done, total: c.stats.total },
      });
      const phases = Object.fromEntries(COLUMNS.map((c) => [c, []]));
      for (const c of cards) phases[c.column].push(slim(c));

      const allChecked = (c) => c.stats.total > 0 && c.stats.done === c.stats.total;
      const readyForProcessing = cards.filter((c) => c.column === "todo" && allChecked(c)).map(slim);
      const readyForDone = cards.filter((c) => c.column === "processing" && allChecked(c)).map(slim);

      const suggestions = [
        ...readyForProcessing.map((c) => ({
          action: "set_status",
          path: c.path,
          to: "processing",
          why: "all checklist items are checked — approved, ready to implement",
        })),
        ...readyForDone.map((c) => ({
          action: "set_status",
          path: c.path,
          to: "done",
          why: "implementation checklist is complete — ready to ship",
        })),
      ];

      return ok({
        repo: localRepoName(),
        statusMode: config.status.from,
        counts: Object.fromEntries(COLUMNS.map((c) => [c, phases[c].length])),
        phases,
        suggestions,
      });
    },
  );

  server.registerTool(
    "cost_estimate",
    {
      title: "Cost estimate",
      description:
        "Token usage for this project across its Claude Code sessions (per model), read from local transcripts.",
    },
    async () => ok(await getLocalCostEstimate()),
  );

  await server.connect(new StdioServerTransport());
  log("ready (stdio) — repo:", localRepoName());
}
