// Shapes every part of the API shares.

/** An ISO-8601 instant as the API writes it (`Date#toISOString()`). */
export type IsoDate = string;

/**
 * The body of every refusal: 4xx and 5xx alike.
 *
 * ⚠️ A 500 always says `"internal error"` and nothing else; the cause is logged
 * on the server, never returned.
 */
export interface ErrorResponse {
  error: string;
}

/** The default origin of the hosted control plane. */
export const DEFAULT_API_ORIGIN = "https://api.lanework.dev";

/**
 * The request header an agent caller names itself with (`claude`, `codex`).
 * Display only: it attributes checkpoints and audit rows, it grants nothing.
 */
export const AGENT_HEADER = "x-lanework-agent";

/** `Authorization: Bearer <machine secret>` — the credential a machine holds. */
export type BearerAuthorization = `Bearer ${string}`;

/** Prefixes of the tokens the API mints. A token is opaque past its prefix. */
export const TOKEN_PREFIXES = {
  registration: "lw_reg_",
  machine: "lw_mch_",
  device: "lw_dev_",
  code: "lw_code_",
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** `GET /v1/health`. Unauthenticated. */
export interface HealthResponse {
  ok: true;
}
