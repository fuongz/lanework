import { createServer } from "node:http";
import type { Socket } from "node:net";
import { CALLBACK_PATH } from "./redirect";

/**
 * Ports we will try, in order.
 *
 * A range rather than one fixed port: two sign-ins at once, or any other
 * process holding 8976, would otherwise fail at bind — at the exact moment the
 * user has no idea what a callback port is. The port we actually bind is the
 * one that goes into `redirect_uri`, so nothing downstream assumes the first
 * one won.
 */
const PORT_FROM = 8976;
const PORT_TO = 8986;

/** How long we wait for a human. Matches the attempt's TTL on the server. */
const WAIT_MS = 10 * 60 * 1000;

/** The one-screen page the browser lands on. Deliberately tiny and offline. */
function page(heading: string, body: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>${heading}</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;
color-scheme:light dark;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
h1{font-size:1.2rem;margin:0 0 .3rem}p{margin:0;opacity:.65}</style>
<div><h1>${heading}</h1><p>${body}</p></div>`;
}

/** Try each port in the range; throw only when every one is taken. */
function bindFirstFree(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return (async () => {
    for (let port = PORT_FROM; port <= PORT_TO; port++) {
      const bound = await new Promise<boolean>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          // Only "port is taken" is worth trying the next port for. EACCES or
          // EADDRNOTAVAIL will repeat on all eleven of them.
          if (error.code === "EADDRINUSE") resolve(false);
          else reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(true);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        // Bound to 127.0.0.1 explicitly, never 0.0.0.0: the default would put a
        // listener that completes a sign-in onto every interface on the machine.
        server.listen(port, "127.0.0.1");
      });
      if (bound) return port;
    }
    throw new Error(
      `No free port between ${PORT_FROM} and ${PORT_TO} to receive the sign-in. Close whatever is using them, or use device sign-in.`,
    );
  })();
}

/**
 * Listen on the first free loopback port and resolve with the callback's code.
 *
 * `onPort` is awaited, and its failure ends the wait: it is what registers the
 * attempt with the control plane, so if that call fails nothing will ever arrive
 * on this socket, and swallowing the error would turn a clear refusal into a
 * ten-minute silence.
 */
export async function listenForCallback(input: {
  state: string;
  onPort: (port: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<string> {
  let resolveHit: (code: string) => void = () => {};
  let rejectHit: (error: Error) => void = () => {};
  const hit = new Promise<string>((resolve, reject) => {
    resolveHit = resolve;
    rejectHit = reject;
  });

  // Tracked so they can be destroyed at shutdown. `server.close()` only stops
  // NEW connections and then waits for existing ones — a browser holds its
  // keep-alive socket open for seconds after the response, so without this the
  // listener outlives a perfectly successful sign-in.
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // Anything that is not the callback gets a flat 404 — a browser asking for
    // /favicon.ico must not look like an answer.
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }

    // ⚠️ The state check happens HERE, before anything is redeemed. Any page the
    // user visits can navigate their browser to this port; without this, a
    // stranger's code would be exchanged and stored as this machine's identity.
    // A mismatch is answered and then IGNORED — we keep waiting for the real
    // callback rather than aborting a sign-in the user did start.
    if (url.searchParams.get("state") !== input.state) {
      res
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Ignored", "That callback did not come from this sign-in."));
      return;
    }

    const code = url.searchParams.get("code");
    // The code is NOT echoed into the page. It is already in the address bar and
    // the browser's history; putting it in the DOM adds a place to leak it and
    // takes nothing back.
    res
      .writeHead(code ? 200 : 400, {
        "Content-Type": "text/html; charset=utf-8",
      })
      .end(
        code
          ? page("Signed in", "You can close this tab and return to the app.")
          : page("Something went wrong", "No authorization code was returned."),
      );

    if (code) resolveHit(code);
    else
      rejectHit(new Error("The control plane returned no authorization code."));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await bindFirstFree(server);
  const timer = new AbortController();

  try {
    await input.onPort(port);

    const expiry = new Promise<never>((_resolve, reject) => {
      const id = setTimeout(
        () =>
          reject(
            new Error(
              "Timed out waiting for the browser. Nothing was changed.",
            ),
          ),
        WAIT_MS,
      );
      timer.signal.addEventListener("abort", () => clearTimeout(id));
    });

    const cancelled = new Promise<never>((_resolve, reject) => {
      if (!input.signal) return;
      if (input.signal.aborted) reject(new Error("Sign-in cancelled."));
      input.signal.addEventListener("abort", () =>
        reject(new Error("Sign-in cancelled.")),
      );
    });

    return await Promise.race([hit, expiry, cancelled]);
  } finally {
    // Cancels the pending timer, so a successful sign-in does not hold the event
    // loop open for the rest of the ten minutes.
    timer.abort();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    server.close();
  }
}
