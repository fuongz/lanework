// The kit's errors (FE-152): one class with a code, so the socket, the MCP
// server and `lwk` all report a failure the same way.
import { FsSearchTimeoutError, RipgrepMissingError } from "../main/fs-kit";
import {
  StructuralPatternError,
  StructuralUnavailableError,
} from "./structural";

/**
 * Why a kit call failed.
 *
 * - `invalid`: the params are wrong.
 * - `scope`: the folder is outside the allowed roots.
 * - `not_found`: the folder does not exist.
 * - `unavailable`: a tool this one needs is missing here.
 * - `timeout`: the search ran out of time before any match.
 * - `aborted`: the caller went away.
 * - `busy`: too many calls at once (the socket only).
 * - `internal`: anything else.
 */
export type KitErrorCode =
  | "invalid"
  | "scope"
  | "not_found"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "busy"
  | "internal";

export class KitError extends Error {
  constructor(
    readonly code: KitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KitError";
  }
}

/** Any error as a {@link KitError}, its message kept readable. */
export function toKitError(error: unknown, signal?: AbortSignal): KitError {
  if (error instanceof KitError) return error;
  if (signal?.aborted) return new KitError("aborted", "The call was aborted.");
  if (error instanceof FsSearchTimeoutError)
    return new KitError(
      "timeout",
      "The search took too long. Try a narrower query or folder.",
    );
  if (error instanceof RipgrepMissingError)
    return new KitError("unavailable", error.message);
  if (error instanceof StructuralUnavailableError)
    return new KitError("unavailable", error.message);
  if (error instanceof StructuralPatternError)
    return new KitError("invalid", error.message);
  const message = error instanceof Error ? error.message : String(error);
  // fs-kit's own words for a pattern or glob rg cannot parse.
  if (/^Not a valid /.test(message)) return new KitError("invalid", message);
  return new KitError("internal", message);
}
