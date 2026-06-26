#!/usr/bin/env node
// `lanework` — run the kanban board locally against the current directory's
// `.agents/reviews` folder. No Cloudflare, no auth, no network: it reads files
// off disk, serves the same UI on 127.0.0.1, and opens your browser — the
// "run like Serena" local mode.
//
// Usage:
//   lanework                 # board for the current directory
//   lanework path/to/repo    # board for another directory
//   lanework --port 24300    # preferred starting port (falls back upward)
//   lanework --no-open       # don't auto-open the browser
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The CLI needs the local build (dist-local). Fail with a clear hint if absent.
if (!existsSync(join(here, "dist-local", "server", "server.js"))) {
  console.error(
    "lanework: local build not found.\n" +
      "Build it first:  bun run --cwd apps/local build  (or `bun run local:build` from the repo root)",
  );
  process.exit(1);
}

// --- parse args --------------------------------------------------------------
const argv = process.argv.slice(2);
let dir = process.cwd();
let port;
let open = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-open") open = false;
  else if (a === "--port" || a === "-p") port = Number(argv[++i]);
  else if (a === "--help" || a === "-h") {
    console.log("Usage: lanework [dir] [--port N] [--no-open]");
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
