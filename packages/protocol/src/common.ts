// Shapes every part of the API shares.

/** An ISO-8601 instant as the API writes it (`Date#toISOString()`). */
export type IsoDate = string;

/**
 * The body of every refusal: 4xx and 5xx alike.
 *
 * A 500 always says `"internal error"` and nothing else. The cause is logged
 * on the server, never returned.
 */
export interface ErrorResponse {
  error: string;
}

/** The default origin of the hosted control plane. */
export const DEFAULT_API_ORIGIN = "https://api.lanework.dev";

/**
 * The request header an agent caller names itself with (`claude`, `codex`).
 *
 * Display only: it attributes checkpoints and audit rows, and grants nothing.
 */
export const AGENT_HEADER = "x-lanework-agent";

/** `Authorization: Bearer <machine secret>`: the credential a machine holds. */
export type BearerAuthorization = `Bearer ${string}`;

/** Prefixes of the tokens the API mints. A token is opaque past its prefix. */
export const TOKEN_PREFIXES = {
  registration: "lw_reg_",
  machine: "lw_mch_",
  device: "lw_dev_",
  code: "lw_code_",
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

/**
 * The shape of a well-formed machine secret: the prefix, then 16 to 190
 * URL-safe characters.
 *
 * A secret goes into an `Authorization` header and into files the hook
 * writes, so anything else (a quote, a newline, a space) is refused rather
 * than stored (FE-78/D1).
 */
export const MACHINE_SECRET_PATTERN = new RegExp(
  `^${TOKEN_PREFIXES.machine}[A-Za-z0-9_-]{16,190}$`,
);

/** Whether `value` is a well-formed machine secret; see the pattern above. */
export function isMachineSecret(value: unknown): value is string {
  return typeof value === "string" && MACHINE_SECRET_PATTERN.test(value);
}

/** `GET /v1/health`. Unauthenticated. */
export interface HealthResponse {
  ok: true;
}
