// Read a response body with a ceiling (FE-78/D8).
//
// `response.json()` and `response.text()` buffer whatever the server sends.
// A misbehaving or hostile origin can stream gigabytes into the main process;
// these readers stop at a cap and cancel the stream instead.

/** Board, card and sync JSON. */
export const JSON_BODY_CAP = 8 * 1024 * 1024;
/** A board icon. */
export const ICON_BODY_CAP = 1024 * 1024;
/** Sign-in, token and machine replies, and reachability probes. */
export const AUTH_BODY_CAP = 64 * 1024;
export const PROBE_BODY_CAP = 64 * 1024;

/** A body was larger than the cap it was read with. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The response was larger than ${maxBytes} bytes.`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * The body as bytes, at most `maxBytes` of them.
 *
 * Refuses early on a `Content-Length` over the cap, and otherwise counts as
 * it reads; past the cap it cancels the stream so the rest is never fetched.
 *
 * @throws {BodyTooLargeError} When the body is longer than `maxBytes`.
 */
export async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The body as UTF-8 text, at most `maxBytes` bytes of it.
 *
 * @throws {BodyTooLargeError} When the body is longer than `maxBytes`.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(response, maxBytes));
}

/**
 * The body parsed as JSON, at most `maxBytes` bytes of it.
 *
 * @throws {BodyTooLargeError} When the body is longer than `maxBytes`.
 * @throws {SyntaxError} When the body is not JSON.
 */
export async function readCappedJson(
  response: Response,
  maxBytes: number = JSON_BODY_CAP,
): Promise<unknown> {
  return JSON.parse(await readCapped(response, maxBytes));
}
