// Local server launcher — serves the Node SSR build (dist-local) on 127.0.0.1,
// the "run like Serena" mode. Static client assets are served from disk; every
// other request is delegated to the TanStack Start SSR fetch handler.
import { serve } from "srvx";
import { readFile, stat } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

const root = fileURLToPath(new URL("./dist-local/", import.meta.url));
const clientDir = join(root, "client");

const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
};

// Import the SSR handler (default export = { fetch }).
const { default: ssr } = await import(new URL("./dist-local/server/server.js", import.meta.url).href);

// Agent dispatcher (lazy — loaded on first /_local/agent request so a problem in
// the runner can't stop the board from booting). Cached after the first import.
let agentRunner;
async function getAgentRunner() {
  if (!agentRunner) agentRunner = await import(new URL("./agent-runner.mjs", import.meta.url).href);
  return agentRunner;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Handle the /_local/agent/* dispatcher endpoints. Returns null if not matched. */
async function handleAgent(request, url) {
  if (url.pathname === "/_local/agent/status" && request.method === "GET") {
    const { agentStatus } = await getAgentRunner();
    return json(await agentStatus());
  }
  const ACTIONS = { "/_local/agent/run": "runAgent", "/_local/agent/stop": "stopAgent", "/_local/agent/merge": "mergeAgent" };
  if (ACTIONS[url.pathname] && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const runner = await getAgentRunner();
    const action = ACTIONS[url.pathname];
    try {
      // run accepts optional mode/model/effort overrides; stop/merge take only the path.
      const result =
        action === "runAgent"
          ? await runner.runAgent(body?.path, {
              mode: body?.mode,
              model: body?.model,
              effort: body?.effort,
            })
          : await runner[action](body?.path);
      return json(result);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }
  return null;
}

/** Resolve a URL path to a file inside clientDir, or null if it escapes/missing. */
async function staticFile(pathname) {
  // Block traversal: normalize and ensure it stays under clientDir.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(clientDir, rel);
  if (!filePath.startsWith(clientDir)) return null;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    return filePath;
  } catch {
    return null;
  }
}

// Nearest existing dir to watch: .agents/reviews → .agents → project root, so a
// reviews folder created after launch still produces change events.
function watchDir(targetDir) {
  for (const d of [join(targetDir, ".agents", "reviews"), join(targetDir, ".agents"), targetDir]) {
    if (existsSync(d)) return d;
  }
  return targetDir;
}

/**
 * SSE stream that emits a `change` event whenever a file under the reviews tree
 * changes. The client (use-local-live.ts) re-runs route loaders on each event.
 */
function liveEvents(targetDir) {
  const enc = new TextEncoder();
  let watcher;
  let heartbeat;
  let debounce;
  const stream = new ReadableStream({
    start(controller) {
      const send = (s) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* stream closed */
        }
      };
      send("retry: 2000\n\n");
      heartbeat = setInterval(() => send(": ping\n\n"), 30000);
      const onChange = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => send("event: change\ndata: 1\n\n"), 120);
      };
      try {
        watcher = watch(watchDir(targetDir), { recursive: true }, onChange);
      } catch {
        /* watch unsupported — board still works, just no live updates */
      }
    },
    cancel() {
      clearInterval(heartbeat);
      clearTimeout(debounce);
      watcher?.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** True if `host:port` is free to bind. */
function portFree(port, host) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, host);
  });
}

/** First free port at or after `start` (Serena-style fallback: 3662, 3663, …). */
async function findFreePort(start, host) {
  for (let p = start; p < start + 100; p++) {
    if (await portFree(p, host)) return p;
  }
  throw new Error(`no free port in ${start}–${start + 100}`);
}

/**
 * Start the local server. Resolves the bound port (after free-port fallback) and
 * the URL. The fetch handler serves static client assets from disk, the live
 * SSE stream, and delegates everything else to the TanStack Start SSR handler.
 */
export async function start({
  dir = process.cwd(),
  host = "127.0.0.1",
  port,
} = {}) {
  const targetDir = dir;
  // Make the dir available to the SSR server functions (local-fs reads it).
  process.env.LANEWORK_DIR = targetDir;
  const startPort = Number(port ?? process.env.PORT) || 3662;
  const boundPort = await findFreePort(startPort, host);

  await serve({
    port: boundPort,
    hostname: host,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/_local/events") return liveEvents(targetDir);
      if (url.pathname.startsWith("/_local/agent/")) {
        const res = await handleAgent(request, url);
        if (res) return res;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const file = await staticFile(url.pathname);
        if (file) {
          const body = await readFile(file);
          const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
          const immutable = url.pathname.startsWith("/assets/");
          return new Response(body, {
            headers: {
              "Content-Type": type,
              "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
            },
          });
        }
      }
      return ssr.fetch(request);
    },
  });

  return { port: boundPort, host, url: `http://${host}:${boundPort}`, dir: targetDir };
}
