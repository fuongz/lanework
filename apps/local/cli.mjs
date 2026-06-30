#!/usr/bin/env node
// `lanework` — run the kanban board locally against the current directory's
// `.agents/reviews` folder. No Cloudflare, no auth, no network: it reads files
// off disk, serves the same UI on 127.0.0.1, and opens your browser — the
// local-first mode.
//
// Usage:
//   lanework                 # board for the current directory
//   lanework path/to/repo    # board for another directory
//   lanework --port 3662     # preferred starting port (falls back upward)
//   lanework --no-open       # don't auto-open the browser
//   lanework mcp             # run as an MCP server (stdio) — for Claude etc.
//   lanework mcp --no-dashboard   # MCP only, don't also open the board
//   lanework setup claude-code    # register the MCP server with Claude Code
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);

// --- `lanework setup <client>` — register the MCP server with a client --------
// Runs before the build check: it only shells out to the client's CLI.
if (argv[0] === "setup") {
  await runSetup(argv.slice(1));
}

// The CLI needs the local build (dist-local). Fail with a clear hint if absent.
if (!existsSync(join(here, "dist-local", "server", "server.js"))) {
  console.error(
    "lanework: local build not found.\n" +
      "Build it first:  bun run --cwd apps/local build  (or `bun run local:build` from the repo root)",
  );
  process.exit(1);
}

// --- `lanework mcp` subcommand: run as an MCP (stdio) server ------------------
// Must run BEFORE any stdout writes — stdout is the JSON-RPC channel.
if (argv[0] === "mcp") {
  const rest = argv.slice(1);
  let mcpDir = process.cwd();
  for (const a of rest) if (!a.startsWith("-")) mcpDir = resolve(a);
  const { startMcp } = await import("./mcp.mjs");
  // Headless by default; the board only opens when --dashboard is passed (and an
  // explicit --no-dashboard always wins, for back-compat with older registrations).
  await startMcp({ dir: mcpDir, dashboard: rest.includes("--dashboard") && !rest.includes("--no-dashboard") });
  // startMcp keeps the process alive on the stdio transport.
} else {
  await runDashboard();
}

async function runDashboard() {
// --- parse args --------------------------------------------------------------
let dir = process.cwd();
let port;
let open = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-open") open = false;
  else if (a === "--port" || a === "-p") port = Number(argv[++i]);
  else if (a === "--help" || a === "-h") {
    console.log(
      "Usage:\n" +
        "  lanework [dir] [--port N] [--no-open]   board a repo's .agents/reviews\n" +
        "  lanework mcp [dir] [--dashboard]        run as an MCP (stdio) server\n" +
        "  lanework setup claude-code [--project] [--dashboard] [--local]   register the MCP server with Claude Code",
    );
    process.exit(0);
  } else if (!a.startsWith("-")) dir = resolve(a);
}

/** Open a URL in the default browser, cross-platform. */
function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

const { start } = await import("./server.mjs");
const { url } = await start({ dir, port });

console.log(`\n  lanework  →  ${url}`);
console.log(`  board for ${dir}/.agents/reviews`);
console.log(`  watching for changes… (Ctrl+C to stop)\n`);

if (open) openBrowser(url);
}

/**
 * `lanework setup claude-code` — register the lanework MCP server with Claude
 * Code by running `claude mcp add` (the one-command install). This
 * gives the MCP *tools* only; for the `/lanework:*` slash commands too, install
 * the plugin (see plugin/README.md). Flags:
 *   --project       scope to the current project (default: --scope user, global)
 *   --dashboard     also auto-open the web board (≈ :3662) whenever Claude Code
 *                   starts. By default the server runs headless (tools only).
 *   --local         register this local build instead of `npx @phake/lanework`
 *   --name <id>     server name (default: lanework)
 */
async function runSetup(args) {
  const client = args.find((a) => !a.startsWith("-"));
  if (client !== "claude-code") {
    console.error(
      "Usage: lanework setup claude-code [--project] [--dashboard] [--local] [--name <id>]",
    );
    process.exit(client ? 1 : 0);
  }
  const useLocal = args.includes("--local");
  const projectScope = args.includes("--project");
  const withDashboard = args.includes("--dashboard");
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : "lanework";

  // Headless by default (tools only); --dashboard also auto-opens the board on startup.
  const tail = withDashboard ? ["mcp", "--dashboard"] : ["mcp"];
  const launch = useLocal
    ? [process.execPath, fileURLToPath(new URL("./cli.mjs", import.meta.url)), ...tail]
    : ["npx", "-y", "@phake/lanework", ...tail];

  const addArgs = ["mcp", "add"];
  if (!projectScope) addArgs.push("--scope", "user");
  addArgs.push(name, "--", ...launch);

  console.log(`Registering the lanework MCP server with Claude Code:\n  claude ${addArgs.join(" ")}\n`);
  // Await the child so we never fall through to the dashboard branch.
  await new Promise(() => {
    const child = spawn("claude", addArgs, { stdio: "inherit" });
    child.on("error", (e) => {
      if (e.code === "ENOENT") {
        console.error("The `claude` CLI was not found. Install Claude Code, then run the command above manually.");
      } else {
        console.error("setup failed:", e.message);
      }
      process.exit(1);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(
          `\n✓ Registered. Restart Claude Code, then run /mcp — server "${name}" should be connected.\n` +
            "  Tools: list_reviews, create_review, set_status, toggle_item, lifecycle_status, …" +
            (withDashboard
              ? "\n  Dashboard: the board opens automatically (≈ http://127.0.0.1:3662) each time Claude Code starts."
              : "\n  Headless: tools only, no board. Re-run with --dashboard to auto-open it on startup."),
        );
      }
      process.exit(code ?? 0);
    });
  });
}
