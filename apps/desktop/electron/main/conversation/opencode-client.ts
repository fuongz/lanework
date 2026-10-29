// OpenCode's v2 HTTP API, as the chat speaks it (FE-104): its background
// service on loopback, every call under `/api/*` with Basic auth
// `opencode:<password>`, the conversation's folder as `?directory=` and as
// `x-opencode-directory`, and every answer's `{ data }` unwrapped.
//
// Its events are Server-Sent Events on `GET /api/event`: `data:` lines, one
// frame per blank line, each frame one JSON object (`{ id, type, data }`).
//
// Ported from Monocode's `provider/opencode/client.rs`. Nothing here imports
// Electron.
//
// NOTE: The password goes to a loopback URL only: `opencode-service.ts` takes
// no other from `opencode service status`, and this checks it again before
// any request carries it.

/** Where OpenCode's background service listens, and its password. */
export interface OpenCodeService {
  url: string;
  password: string;
}

type Json = Record<string, unknown>;

/** A loopback http(s) URL, the only kind the password may go to. */
const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/i;

/** How long one request is waited on, unless the caller says otherwise. */
const REQUEST_MS = 30_000;
/** How long the event stream may take to answer. */
const CONNECT_MS = 15_000;
/** The most one frame or one answer may be, in characters. */
const BODY_MAX = 32 * 1024 * 1024;

/** OpenCode answered with an error status. */
export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

/**
 * What an OpenCode error says, from any of the shapes it sends: a string,
 * `{ message }`, `{ data: { message } }` or `{ error: { message } }`.
 */
export function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  const v = record(value);
  for (const candidate of [
    v.message,
    record(v.data).message,
    record(v.error).message,
  ])
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  return fallback;
}

/**
 * Server-Sent Events, parsed as they arrive.
 *
 * `data:` lines (one space after the colon dropped) are joined with a newline
 * and end at a blank line, as one JSON frame. Comments (`: heartbeat`),
 * `event:` and `id:` lines carry nothing this needs; a frame that is not JSON
 * is dropped.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  /** Take a chunk of the stream; answers every frame it completed. */
  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const frames: unknown[] = [];
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (!this.data.length) continue;
        const text = this.data.join("\n");
        this.data = [];
        try {
          frames.push(JSON.parse(text));
        } catch {
          // Not JSON: not one of OpenCode's frames.
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      if (field !== "data") continue;
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      this.data.push(value);
    }
    // A runaway frame is not OpenCode's.
    if (
      this.buffer.length > BODY_MAX ||
      this.data.reduce((sum, part) => sum + part.length, 0) > BODY_MAX
    ) {
      this.buffer = "";
      this.data = [];
    }
    return frames;
  }
}

/** An event frame's type and payload: v2 sends `data`, v1 `properties`. */
export function frameOf(value: unknown): { type: string; data: Json } | null {
  const frame = record(value);
  if (typeof frame.type !== "string") return null;
  return {
    type: frame.type,
    data: record(frame.data ?? frame.properties),
  };
}

/** The open event stream; `close` ends it, and no end is told after. */
export interface OpenCodeEvents {
  close(): void;
}

export interface OpenCodeClient {
  /** The folder every call is scoped to; null for the machine's lists. */
  readonly directory: string | null;
  /**
   * Call `path` (`/api/...`) and answer its `data`.
   *
   * @throws {OpenCodeHttpError} When OpenCode answers with an error status;
   *   a plain Error when it cannot be reached or times out.
   */
  request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  /**
   * Open `GET /api/event`. Resolves once OpenCode answered 200, so a prompt
   * sent after it misses none of its events.
   *
   * @param onEnd Told once when the stream ends or breaks, unless it was
   *   closed.
   */
  events(
    onFrame: (frame: unknown) => void,
    onEnd: (error: string) => void,
  ): Promise<OpenCodeEvents>;
}

/** `path` segment, encoded: an id never adds a path of its own. */
export const segment = (value: string): string => encodeURIComponent(value);

/**
 * A client for `service`, scoped to `directory`.
 *
 * @param fetcher A test seam; the runtime's `fetch` by default.
 * @throws When the service's URL is not loopback.
 */
export function openCodeClient(
  service: OpenCodeService,
  directory: string | null,
  fetcher: typeof fetch = fetch,
): OpenCodeClient {
  const base = service.url.replace(/\/+$/, "");
  if (!LOOPBACK.test(base))
    throw new Error("OpenCode's service is not on this Mac.");
  const auth = `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`;

  function url(path: string): string {
    const at = new URL(`${base}${path}`);
    if (directory) at.searchParams.set("directory", directory);
    return at.toString();
  }

  function headers(json: boolean): Record<string, string> {
    return {
      Authorization: auth,
      Accept: json ? "application/json" : "text/event-stream",
      ...(directory
        ? { "x-opencode-directory": encodeURIComponent(directory) }
        : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = REQUEST_MS,
  ): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetcher(url(path), {
        method,
        headers: headers(true),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new Error(
        abort.signal.aborted
          ? `OpenCode did not answer ${method} ${path}.`
          : `Could not reach OpenCode: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (text.length > BODY_MAX) throw new Error("OpenCode answered too much.");
    let value: unknown = null;
    if (text.trim())
      try {
        value = JSON.parse(text);
      } catch {
        if (response.ok)
          throw new Error("OpenCode answered with invalid JSON.");
        value = text;
      }
    if (!response.ok)
      throw new OpenCodeHttpError(
        response.status,
        `OpenCode HTTP ${response.status}: ${errorMessage(value, response.statusText).slice(0, 300)}`,
      );
    const v = record(value);
    return "data" in v ? v.data : value;
  }

  async function events(
    onFrame: (frame: unknown) => void,
    onEnd: (error: string) => void,
  ): Promise<OpenCodeEvents> {
    const abort = new AbortController();
    let closed = false;
    const timer = setTimeout(() => abort.abort(), CONNECT_MS);
    let response: Response;
    try {
      response = await fetcher(url("/api/event"), {
        method: "GET",
        headers: headers(false),
        signal: abort.signal,
      });
    } catch (error) {
      throw new Error(
        abort.signal.aborted
          ? "OpenCode's event stream did not answer."
          : `Could not reach OpenCode: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      abort.abort();
      throw new OpenCodeHttpError(
        response.status,
        `OpenCode's event stream failed (HTTP ${response.status}).`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    void (async () => {
      let why = "OpenCode's event stream ended.";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(
            decoder.decode(value, { stream: true }),
          )) {
            if (closed) return;
            try {
              onFrame(frame);
            } catch {
              // One odd frame never stops the stream.
            }
          }
        }
      } catch (error) {
        why = `OpenCode's event stream broke: ${(error as Error).message}`;
      }
      if (!closed) {
        closed = true;
        onEnd(why);
      }
    })();
    return {
      close() {
        if (closed) return;
        closed = true;
        abort.abort();
        void reader.cancel().catch(() => {});
      },
    };
  }

  return { directory, request, events };
}
