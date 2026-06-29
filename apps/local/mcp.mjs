// lanework MCP server (stdio) — the "Serena-style" mode.
//
// Claude (or any MCP client) launches `lanework mcp`. This:
//   1. exposes tools the agent calls to read/update the repo's .agents/reviews,
//   2. optionally boots the web dashboard + opens the browser, like Serena.
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
} = await import(libUrl);

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

  const server = new McpServer({ name: "lanework", version: "0.1.0" });

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
